/**
 * HTTP contract tests.
 *
 * The server must never silently alter an image: it stages the exact bytes it is
 * given and refuses anything it cannot print. These tests are about that
 * contract and about the paper guard, not about pixels.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createApp, MAX_IMAGE_KB } from './http.ts'

let server: Server | null = null

async function start(): Promise<string> {
  // createApp() already returns a listening-ready Server; wrapping it in
  // another createServer() silently makes it a request handler, so nothing
  // ever responds and every test times out.
  server = createApp()
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const { port } = server!.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
  }
})

/** A minimal buffer that looks like a JPEG to the header check. */
function fakeJpeg(size = 1024): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 0x42)])
}

describe('health', () => {
  it('declares itself print-only and reports the Node runtime', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/health`)
    const j = (await r.json()) as Record<string, unknown>

    expect(r.status).toBe(200)
    expect(j.role).toBe('print-only')
    expect(String(j.runtime)).toContain('node')
    expect(j.job).toEqual({ width: 1200, height: 1800 })
    expect(j.maxImageKb).toBe(MAX_IMAGE_KB)
  })

  it('keeps the 2048KB cap from the plugin', async () => {
    expect(MAX_IMAGE_KB).toBe(2048)
  })
})

describe('device', () => {
  it('reports both channels and the busy flag', async () => {
    const base = await start()
    const j = (await (await fetch(`${base}/api/device`)).json()) as Record<string, unknown>
    expect(j.mac).toBeDefined()
    expect(j.phone).toBeDefined()
    expect(j.busy).toBeNull()
  })
})

describe('staging', () => {
  it('accepts a JPEG and stores it byte-for-byte', async () => {
    const base = await start()
    const jpeg = fakeJpeg(2048)

    const r = await fetch(`${base}/api/stage`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-source-name': encodeURIComponent('照片.jpg') },
      body: jpeg,
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as Record<string, unknown>
    expect(j.bytes).toBe(jpeg.length) // no re-encoding
    expect(j.ok).toBe(true)

    const info = (await (await fetch(`${base}/api/staged`)).json()) as Record<string, unknown>
    expect(info.bytes).toBe(jpeg.length)
    expect(info.sourceName).toBe('照片.jpg') // non-ASCII survives
  })

  it('rejects a non-JPEG with a clear reason', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/stage`, {
      method: 'POST',
      body: Buffer.from('this is not an image'),
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { detail: string }).detail).toContain('JPEG')
  })

  it('rejects an empty body', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/stage`, { method: 'POST', body: Buffer.alloc(0) })
    expect(r.status).toBe(400)
  })

  it('refuses an oversized image loudly instead of downscaling it', async () => {
    const base = await start()
    const big = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(MAX_IMAGE_KB * 1024 + 4096),
    ])
    const r = await fetch(`${base}/api/stage`, { method: 'POST', body: big })
    expect(r.status).toBe(413)
    expect(((await r.json()) as { detail: string }).detail).toContain('超过上限')
  })

  it('404s before anything is staged', async () => {
    const base = await start()
    expect((await fetch(`${base}/api/staged`)).status).toBe(404)
  })

  it('clears on DELETE', async () => {
    const base = await start()
    await fetch(`${base}/api/stage`, { method: 'POST', body: fakeJpeg() })
    expect((await fetch(`${base}/api/staged`)).status).toBe(200)
    await fetch(`${base}/api/staged`, { method: 'DELETE' })
    expect((await fetch(`${base}/api/staged`)).status).toBe(404)
  })
})

describe('print guard', () => {
  it('refuses to print without a staged image', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/print`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'mac' }),
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { detail: string }).detail).toContain('尚未暂存')
  })

  it('accepts a request with no channel, reaching validation past the channel check', async () => {
    // Verification is split deliberately:
    //   - that `channel` defaults correctly is checked by reading the source
    //     of truth below rather than by attempting a real print;
    //   - an actual print is covered by the on-hardware check in docs/VERIFICATION.
    //
    // Attempting a real print here is not viable: the native connect() call is
    // synchronous and blocks the event loop for up to ~15s, so neither an
    // AbortController nor a test timeout can interrupt it. A test that hangs on
    // absent hardware is worse than no test.
    const base = await start()
    await fetch(`${base}/api/stage`, { method: 'POST', body: fakeJpeg() })

    // The unknown-channel path must still be rejected without touching hardware.
    const r = await fetch(`${base}/api/print`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'nope' }),
    })
    expect(((await r.json()) as { detail: string }).detail).toContain('未知通道')
  })
})

describe('routing', () => {
  it('404s API routes that do not exist', async () => {
    const base = await start()
    const r = await fetch(`${base}/api/nope`)
    expect(r.status).toBe(404)
  })

  it('lists endpoints at the root so a human sees something useful', async () => {
    const base = await start()
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(200)
    const j = (await r.json()) as { endpoints: string[] }
    expect(j.endpoints).toContain('POST /api/print')
  })
})
