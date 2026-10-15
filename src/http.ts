/**
 * The HTTP surface.
 *
 * Built on Node's own `http` rather than a framework: there are seven endpoints
 * and no routing beyond a switch on the path, so a framework would add a
 * dependency and a layer of indirection without removing any real work. The one
 * thing worth having from a framework — body parsing — is a dozen lines here.
 *
 * Scope (see ADR-0003): this service does not process images. The caller
 * renders the finished sheet; the server stages those bytes and hands them to
 * the printer.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'

import { BluetoothLink, addonBuilt, addonPath, listCandidates } from './bluetooth.ts'
import { PrintSession, PrinterError } from './session.ts'

/** Mirrors the plugin's `imageSizeQualityCompress` default (2048 KB). */
/**
 * Service version, read from package.json so the two cannot drift apart.
 * (They did: the endpoint reported 3.0.0 while the manifest said 1.0.0.)
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

export const MAX_IMAGE_KB = 2048
const MAX_IMAGE_BYTES = MAX_IMAGE_KB * 1024

/** Printer job parameters, hard-coded in the plugin. */
export const JOB_WIDTH = 1200
export const JOB_HEIGHT = 1800

const STAGE_FILE = join(tmpdir(), 'pocket_print_staged.jpg')

export interface Staged {
  bytes: number
  stagedAt: number
  sourceName: string
}

export interface ServerOptions {
  port?: number
  verbose?: boolean
  /** Force a specific printer address instead of discovering one. */
  address?: string
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
  })
  res.end(data)
}

function sendError(res: ServerResponse, code: number, detail: string): void {
  sendJson(res, code, { detail })
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) {
      throw Object.assign(new Error('body too large'), { code: 413 })
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 1 << 20)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function createApp(opts: ServerOptions = {}) {
  let staged: Staged | null = null
  let busy: string | null = null

  /** Run `fn` with exclusive access to the printer. */
  async function withPrinter<T>(fn: (s: PrintSession, address: string) => Promise<T>): Promise<T> {
    if (busy) throw new Error(`打印机忙：${busy}`)
    busy = '正在连接…'
    const link = new BluetoothLink({ verbose: opts.verbose, address: opts.address })
    const session = new PrintSession(link, opts.verbose)
    try {
      await session.connect()
      busy = null
      return await fn(session, link.resolvedAddress)
    } finally {
      busy = null
      await session.close().catch(() => {})
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    // ------------------------------------------------------------- metadata
    if (path === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        runtime: `node ${process.version}`,
        role: 'print-only',
        job: { width: JOB_WIDTH, height: JOB_HEIGHT },
        maxImageKb: MAX_IMAGE_KB,
      })
    }

    if (path === '/api/device' && method === 'GET') {
      // `mac` is the channel name the UI uses for this machine's own Bluetooth;
      // the field is named for the channel, not the operating system.
      const built = addonBuilt()
      // Report candidates so the UI can show what was found without connecting.
      let candidates: Array<{ address: string; name: string }> = []
      if (built) {
        try {
          candidates = listCandidates().map((c) => ({ address: c.address, name: c.name }))
        } catch {
          /* enumeration is best-effort */
        }
      }
      return sendJson(res, 200, {
        mac: {
          available: built,
          configured: Boolean(process.env.PRINTER_ADDRESS),
          candidates,
          message: built ? undefined : '原生蓝牙模块未编译，请运行：npm run build:native',
        },
        phone: { online: false }, // the phone relay is not part of this service
        busy,
      })
    }

    if (path === '/api/printer/status' && method === 'GET') {
      if (!addonBuilt()) {
        return sendJson(res, 200, {
          available: false,
          message: `原生蓝牙模块未编译（${addonPath()}）`,
        })
      }
      try {
        const result = await withPrinter(async (s, address) => {
          // SERIAL, not Promise.all. The protocol is strictly request/response
          // over one channel: two commands in flight means both waiters race for
          // the single reply, and one reports "no response" even though the
          // printer answered. That race is what made a healthy printer look
          // broken here.
          const status = await s.status()
          const info = await s.deviceInfo()
          return { status, info, address }
        })
        return sendJson(res, 200, {
          available: true,
          reachable: true,
          handshake_ok: true,
          device: result.address,
          battery: result.status.battery,
          category: result.status.category,
          fw: result.info.fw,
          sn: result.info.sn,
          model: result.info.model,
        })
      } catch (e) {
        return sendJson(res, 200, {
          available: true,
          reachable: false,
          handshake_ok: false,
          message: e instanceof Error ? e.message : String(e),
        })
      }
    }

    // ---------------------------------------------------------------- stage
    if (path === '/api/stage' && method === 'POST') {
      let raw: Buffer
      try {
        raw = await readBody(req, MAX_IMAGE_BYTES + 1)
      } catch (e) {
        if ((e as { code?: number }).code === 413) {
          return sendError(res, 413, `成片超过上限 ${MAX_IMAGE_KB}KB，请降低导出质量后重试`)
        }
        throw e
      }
      if (!raw.length) return sendError(res, 400, '没有收到图片数据')
      if (raw.length > MAX_IMAGE_BYTES) {
        return sendError(
          res, 413,
          `成片 ${Math.round(raw.length / 1024)}KB 超过上限 ${MAX_IMAGE_KB}KB。` +
            `请降低导出质量后重试。`,
        )
      }
      // Never silently re-encode: that is how a print ends up different from
      // what the user approved.
      if (!(raw[0] === 0xff && raw[1] === 0xd8)) {
        return sendError(res, 400, '成片必须是 JPEG（未检测到 JPEG 文件头）')
      }
      writeFileSync(STAGE_FILE, raw)
      const name = decodeURIComponent(String(req.headers['x-source-name'] ?? ''))
      staged = { bytes: raw.length, stagedAt: Date.now(), sourceName: name }
      return sendJson(res, 200, {
        ok: true,
        bytes: staged.bytes,
        kb: Math.round((staged.bytes / 1024) * 10) / 10,
      })
    }

    if (path === '/api/staged' && method === 'GET') {
      if (!staged) return sendError(res, 404, '尚未生成成片')
      return sendJson(res, 200, { ok: true, ...staged })
    }

    if (path === '/api/staged' && method === 'DELETE') {
      staged = null
      return sendJson(res, 200, { ok: true })
    }

    // ---------------------------------------------------------------- print
    if (path === '/api/print' && method === 'POST') {
      const body = await readJson(req)
      const channel = String(body.channel ?? 'mac')
      if (channel !== 'mac') {
        return sendError(res, 400, `未知通道：${channel}（本服务只提供本机蓝牙通道）`)
      }
      if (!staged) return sendError(res, 400, '尚未暂存成片，请先导出并暂存')

      const file = await readFile(STAGE_FILE)
      try {
        const result = await withPrinter(async (s) => {
          const before = await s.status()
          if (before.category && before.category !== 'idle') {
            throw new PrinterError(`打印机当前状态为 ${before.category}，不是空闲，已中止`)
          }
          const jobId = await s.createJob(file.length)
          await s.sendFile(file, jobId)
          const final = await s.waitForJob(jobId, { verbose: opts.verbose } as never)
          return { jobId, final }
        })
        const ok = result.final.state === 'finished'
        return sendJson(res, 200, {
          ok,
          message: ok
            ? `打印完成（任务 ${result.jobId}）`
            : `任务未确认完成（${result.final.state}，任务 ${result.jobId}）`,
          job_id: result.jobId,
          state: result.final.state,
          print_time: result.final.printTime,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const hint = msg.includes('不可达')
          ? '打印机不可达：请确认已开机'
          : msg.includes('原生蓝牙模块')
            ? '请先编译原生模块：npm run build:native'
            : ''
        return sendJson(res, 200, { ok: false, message: hint || msg })
      }
    }

    // A bare GET / is a convenience so a human opening the port sees something
    // useful instead of a 404.
    if (path === '/' && method === 'GET') {
      return sendJson(res, 200, {
        service: '口袋打印机 · 送印服务',
        endpoints: [
          'GET  /api/health',
          'GET  /api/device',
          'GET  /api/printer/status',
          'POST /api/stage',
          'GET  /api/staged',
          'DELETE /api/staged',
          'POST /api/print',
        ],
      })
    }

    sendError(res, 404, `未找到 ${method} ${path}`)
  }

  return createServer((req, res) => {
    handler(req, res).catch((e) => {
      sendError(res, 500, e instanceof Error ? e.message : String(e))
    })
  })
}
