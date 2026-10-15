/**
 * The print service: the one place that owns the printer.
 *
 * Two responsibilities, both of which were previously implicit and therefore
 * easy to get wrong:
 *
 * 1. **Exclusive access.** The RFCOMM channel is exclusive, and the protocol is
 *    strictly one-request-one-response. Every command must be serialised through
 *    a single queue. Previously the HTTP layer called the session directly and a
 *    `Promise.all` in one endpoint caused two commands to race for the same
 *    reply — the printer looked broken while being perfectly healthy.
 *
 * 2. **Job state.** A print takes ~75 seconds (4s transfer + 70s printing).
 *    Blocking an HTTP request that long is hostile: clients time out and cannot
 *    show progress. Jobs are therefore tracked here and polled by the caller.
 */

import { Injectable, Logger } from '@nestjs/common'
import { Observable, Subject } from 'rxjs'
import { readFile } from 'node:fs/promises'

import { BluetoothLink, addonBuilt, addonPath, listCandidates } from './bluetooth.ts'
import { PrintSession, PrinterError, JOB_TYPE } from './session.ts'
import { frameCountFor } from './protocol.ts'
import { ConflictError } from '../common/errors.ts'

export type JobState = 'queued' | 'transferring' | 'printing' | 'finished' | 'failed' | 'cancelled'

export interface PrintJob {
  id: string
  /** Original file name, for display only. */
  sourceName: string
  bytes: number
  frames: number
  state: JobState
  /** 0..1 while transferring, then 1. */
  progress: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** Printer-assigned id, once known. */
  printerJobId?: number
  printTimeMs?: number
  error?: string
}

export interface PrinterStatus {
  available: boolean
  reachable: boolean
  handshakeOk: boolean
  device?: string
  battery?: number
  category?: string
  fw?: string
  sn?: string
  model?: string
  message?: string
}

/** How long a finished job stays queryable before being pruned. */
const JOB_TTL_MS = 30 * 60 * 1000
const MAX_JOBS = 50

@Injectable()
export class PrinterService {
  private readonly log = new Logger(PrinterService.name)
  private readonly jobs = new Map<string, PrintJob>()

  /** Serialises all access to the printer. See class comment (1). */
  private chain: Promise<unknown> = Promise.resolve()

  /** The currently running job id, if any. */
  private activeJob: string | null = null

  /**
   * Emits every job update, for subscribers (SSE) to observe.
   *
   * The alternative — having the SSE endpoint poll the job map on a timer —
   * works but wastes a tick per subscriber per second and reports state changes
   * up to a second late. Publishing changes makes the stream event-driven and
   * exactly as timely as the job itself.
   */
  private readonly updates = new Subject<PrintJob>()

  /** Observe job changes. Each emission is the job's current state. */
  watch(): Observable<PrintJob> {
    return this.updates.asObservable()
  }

  /**
   * Run `fn` with exclusive access to the printer.
   *
   * Tasks are chained rather than rejected when busy, so a status probe issued
   * during a print simply waits its turn instead of failing. The connection is
   * opened per task: RFCOMM cannot be held open indefinitely between commands
   * without the printer eventually dropping it.
   */
  private run<T>(label: string, fn: (session: PrintSession, address: string) => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      if (!addonBuilt()) {
        throw new PrinterError(
          `原生蓝牙模块未编译。请运行：npm run build:native（缺少 ${addonPath()}）`,
        )
      }
      const link = new BluetoothLink()
      const session = new PrintSession(link, false)
      try {
        await session.connect()
        return await fn(session, link.resolvedAddress)
      } finally {
        await session.close().catch(() => {})
      }
    })
    // Keep the chain alive even if this task fails, or every later task would
    // reject immediately with the previous error.
    this.chain = task.catch(() => {})
    return task.catch((e: unknown) => {
      this.log.warn(`${label} 失败：${e instanceof Error ? e.message : String(e)}`)
      throw e
    }) as Promise<T>
  }

  // ------------------------------------------------------------------ probes

  async status(): Promise<PrinterStatus> {
    if (!addonBuilt()) {
      return {
        available: false,
        reachable: false,
        handshakeOk: false,
        message: `原生蓝牙模块未编译，请运行：npm run build:native`,
      }
    }
    try {
      return await this.run('status', async (s, address) => {
        // SERIAL, deliberately. The protocol is one-request-one-response; two
        // commands in flight make both waiters race for the same reply.
        const st = await s.status()
        const info = await s.deviceInfo()
        return {
          available: true,
          reachable: true,
          handshakeOk: true,
          device: address,
          battery: st.battery,
          category: st.category,
          fw: info.fw,
          sn: info.sn,
          model: info.model,
        }
      })
    } catch (e) {
      return {
        available: true,
        reachable: false,
        handshakeOk: false,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  /** Bluetooth devices the system knows about; no connection is made. */
  candidates(): Array<{ address: string; name: string }> {
    if (!addonBuilt()) return []
    try {
      return listCandidates().map((c) => ({ address: c.address, name: c.name }))
    } catch {
      return []
    }
  }

  /** True while a print job is in flight. */
  get busy(): string | null {
    return this.activeJob
  }

  // ------------------------------------------------------------------- jobs

  /**
   * Start printing a staged file. Returns immediately with a job record.
   *
   * The caller polls `getJob(id)` for progress. This replaces the old blocking
   * `POST /api/print` that held the request open for ~75 seconds.
   */
  startPrint(imagePath: string, sourceName: string): PrintJob {
    if (this.activeJob) {
      throw new ConflictError(`打印机忙：正在处理任务 ${this.activeJob}`)
    }

    const job: PrintJob = {
      id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sourceName,
      bytes: 0,
      frames: 0,
      state: 'queued',
      progress: 0,
      createdAt: Date.now(),
    }
    this.jobs.set(job.id, job)
    this.prune()
    this.activeJob = job.id

    // Fire and forget: the job's own record carries the outcome.
    void this.executeJob(job, imagePath).finally(() => {
      if (this.activeJob === job.id) this.activeJob = null
    })

    return job
  }

  /** Record a state change and notify subscribers. */
  private update(job: PrintJob, patch: Partial<PrintJob>): void {
    Object.assign(job, patch)
    this.updates.next({ ...job })
  }

  private async executeJob(job: PrintJob, imagePath: string): Promise<void> {
    try {
      const file = await readFile(imagePath)
      this.update(job, {
        bytes: file.length,
        frames: frameCountFor(file.length),
        startedAt: Date.now(),
        state: 'transferring',
      })

      const result = await this.run('print', async (s) => {
        const before = await s.status()
        if (before.category && before.category !== 'idle') {
          throw new PrinterError(`打印机当前状态为 ${before.category}，不是空闲，已中止`)
        }

        const printerJobId = await s.createJob(file.length, 1, JOB_TYPE.PHOTO)
        this.update(job, { printerJobId, progress: 0.1 })

        await s.sendFile(file, printerJobId)
        this.update(job, { progress: 0.5, state: 'printing' })

        // Poll until finished; report progress from the printer's own counters.
        const final = await s.waitForJob(printerJobId, {
          timeoutMs: 180_000,
          intervalMs: 3_000,
          onTick: (t) => {
            this.update(job, {
              state: t.state === 'finished' ? 'finished' : 'printing',
              printTimeMs: t.printTime,
              // The transfer is done by now, so progress reflects printing.
              progress: 0.5,
            })
          },
        })
        return { printerJobId, final }
      })

      const done: Partial<PrintJob> = {
        state: result.final.state === 'finished' ? 'finished' : 'failed',
        progress: 1,
        printTimeMs: result.final.printTime,
        finishedAt: Date.now(),
      }
      if (done.state === 'failed') done.error = `任务未确认完成（${result.final.state}）`
      this.update(job, done)
      this.log.log(`任务 ${job.id} 结束：${job.state}（打印机任务 ${result.printerJobId}）`)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.update(job, { state: 'failed', error, finishedAt: Date.now() })
      this.log.warn(`任务 ${job.id} 失败：${error}`)
    }
  }

  getJob(id: string): PrintJob | undefined {
    return this.jobs.get(id)
  }

  listJobs(): PrintJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Drop old finished jobs so the map cannot grow without bound. */
  private prune(): void {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      const done = job.state === 'finished' || job.state === 'failed' || job.state === 'cancelled'
      if (done && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
        this.jobs.delete(id)
      }
    }
    if (this.jobs.size > MAX_JOBS) {
      const finished = [...this.jobs.values()]
        .filter((j) => j.finishedAt)
        .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
      for (const j of finished.slice(0, this.jobs.size - MAX_JOBS)) {
        this.jobs.delete(j.id)
      }
    }
  }
}
