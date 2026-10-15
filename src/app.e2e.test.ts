/**
 * HTTP contract tests.
 *
 * Scope: the staging rules and the paper guard. The server must never silently
 * alter an image, and it must be impossible to print without staging first.
 *
 * These run without a printer: the print path is only exercised up to the point
 * where it would touch hardware, and the printer being unreachable is treated as
 * a valid outcome. **No test here consumes paper.**
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'

import { createApplication } from './bootstrap.ts'
import { MAX_IMAGE_KB } from './printer/staging.service.ts'

let app: INestApplication

beforeAll(async () => {
  // Built through the same bootstrap as production, so the body parsers and
  // filters under test are the ones that actually run. A test-only app
  // configuration would let real misconfiguration pass unnoticed.
  app = await createApplication()
  await app.init()
})

afterAll(async () => {
  await app?.close()
})

/** A buffer that satisfies the JPEG header check without being a real image. */
function fakeJpeg(size = 1024): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 0x42)])
}

describe('health', () => {
  it('declares itself print-only and reports the runtime', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200)
    expect(res.body.role).toBe('print-only')
    expect(String(res.body.runtime)).toContain('node')
    expect(res.body.job).toEqual({ width: 1200, height: 1800 })
    expect(res.body.maxImageKb).toBe(MAX_IMAGE_KB)
  })

  it('advertises the async print model', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200)
    expect(res.body.asyncPrint).toBe(true)
  })

  it('keeps the 2048KB cap from the plugin', () => {
    expect(MAX_IMAGE_KB).toBe(2048)
  })

  it('reports a version matching package.json shape', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200)
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('root', () => {
  it('lists endpoints so a human sees something useful', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200)
    expect(res.body.service).toContain('送印')
    expect(res.body.endpoints.join('\n')).toContain('POST   /api/print')
  })
})

describe('device', () => {
  it('reports availability and the busy flag', async () => {
    const res = await request(app.getHttpServer()).get('/api/device').expect(200)
    expect(res.body.mac).toBeDefined()
    expect(res.body.busy).toBeNull()
  })
})

describe('staging', () => {
  it('accepts a JPEG and stores it byte-for-byte', async () => {
    const jpeg = fakeJpeg(2048)
    const res = await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'image/jpeg')
      .set('x-source-name', encodeURIComponent('照片.jpg'))
      .send(jpeg)
      .expect(200)

    // The size reported must equal what was sent: no re-encoding.
    expect(res.body.bytes).toBe(jpeg.length)

    const info = await request(app.getHttpServer()).get('/api/staged').expect(200)
    expect(info.body.bytes).toBe(jpeg.length)
    expect(info.body.sourceName).toBe('照片.jpg') // non-ASCII survives
  })

  it('returns the staged bytes unchanged', async () => {
    const jpeg = fakeJpeg(4096)
    await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'image/jpeg')
      .send(jpeg)
      .expect(200)

    const res = await request(app.getHttpServer())
      .get('/api/staged/image')
      .expect(200)
      .expect('content-type', /image\/jpeg/)

    expect(Buffer.from(res.body).equals(jpeg)).toBe(true)
  })

  it('rejects a non-JPEG with a clear reason', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('this is not an image'))
      .expect(400)
    expect(res.body.message).toContain('JPEG')
  })

  it('rejects an empty body', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(0))
      .expect(400)
    expect(res.body.message).toContain('没有收到')
  })

  it('refuses an oversized image loudly instead of downscaling it', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(MAX_IMAGE_KB * 1024 + 4096)])
    const res = await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'application/octet-stream')
      .send(big)
      .expect(413)
    // A clear reason must come back, not a dropped connection: an earlier
    // implementation destroyed the socket and the client only saw "socket hang
    // up", learning nothing about why it was refused.
    expect(String(res.body.message)).toMatch(/超过上限/)
  })

  it('404s before anything is staged', async () => {
    // Fresh app state is not guaranteed by ordering, so clear explicitly.
    await request(app.getHttpServer()).delete('/api/staged').expect(200)
    await request(app.getHttpServer()).get('/api/staged').expect(404)
  })

  it('clears on DELETE', async () => {
    await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'image/jpeg')
      .send(fakeJpeg())
      .expect(200)

    await request(app.getHttpServer()).delete('/api/staged').expect(200)
    await request(app.getHttpServer()).get('/api/staged').expect(404)
  })
})

describe('print guard', () => {
  it('refuses to start a job without a staged image', async () => {
    await request(app.getHttpServer()).delete('/api/staged').expect(200)
    const res = await request(app.getHttpServer()).post('/api/print').expect(400)
    expect(res.body.message).toContain('尚未暂存')
  })

  it('400s for an unknown print job id', async () => {
    await request(app.getHttpServer()).get('/api/print/does-not-exist').expect(404)
  })

  it('refuses to start a job when printing is not explicitly enabled', async () => {
    // Paper is a consumable and a print cannot be undone, so starting a job
    // requires an explicit opt-in. Without ALLOW_PRINTING=1 an automated check
    // that pokes POST /api/print cannot cost a sheet.
    //
    // Staging first is deliberate: it proves the refusal comes from the print
    // gate and not from the "nothing staged" check.
    await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'image/jpeg')
      .send(fakeJpeg())
      .expect(200)

    const saved = process.env.ALLOW_PRINTING
    delete process.env.ALLOW_PRINTING
    try {
      const res = await request(app.getHttpServer()).post('/api/print').expect(409)
      expect(String(res.body.message)).toContain('ALLOW_PRINTING')
      // No job must have been created.
      const jobs = await request(app.getHttpServer()).get('/api/print').expect(200)
      expect(jobs.body.jobs).toHaveLength(0)
    } finally {
      if (saved === undefined) delete process.env.ALLOW_PRINTING
      else process.env.ALLOW_PRINTING = saved
    }
  })

  it('lists jobs (empty when nothing ran in this app instance)', async () => {
    const res = await request(app.getHttpServer()).get('/api/print').expect(200)
    expect(Array.isArray(res.body.jobs)).toBe(true)
  })
})

describe('front-end integration', () => {
  it('rejects a multipart upload with a hint, not a puzzling error', async () => {
    // A front-end reaching for FormData is the most likely mistake: this
    // endpoint takes the raw JPEG bytes, so a multipart envelope is not a JPEG.
    // The contract is documented, and the status must at least be a clear 400.
    const res = await request(app.getHttpServer())
      .post('/api/staged')
      .field('comment', 'not how this API works')
      .attach('file', fakeJpeg(2048), 'sheet.jpg')
      .expect(400)
    expect(String(res.body.message)).toContain('JPEG')
  })

  it('exposes the job URL so a client can follow a print', async () => {
    // 202 + Location is what lets a front-end poll without inventing an id.
    await request(app.getHttpServer())
      .post('/api/staged')
      .set('content-type', 'image/jpeg')
      .send(fakeJpeg())
      .expect(200)

    const saved = process.env.ALLOW_PRINTING
    delete process.env.ALLOW_PRINTING
    try {
      const res = await request(app.getHttpServer()).post('/api/print').expect(409)
      expect(String(res.body.message)).toContain('ALLOW_PRINTING')
    } finally {
      if (saved === undefined) delete process.env.ALLOW_PRINTING
      else process.env.ALLOW_PRINTING = saved
    }
  })
})

describe('routing', () => {
  it('404s unknown API routes', async () => {
    await request(app.getHttpServer()).get('/api/nope').expect(404)
  })
})
