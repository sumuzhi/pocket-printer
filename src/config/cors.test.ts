/**
 * CORS configuration.
 *
 * Joint development happens from a separate dev server (Vite on 5173, say), so
 * the API must be reachable cross-origin — and disabled by default, because the
 * service is normally used directly. These tests pin both halves, and the SSE
 * case in particular: EventSource cannot work around a missing CORS header.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'

import { AppModule } from '../app.module.ts'
import { configureApp } from '../bootstrap.ts'

const KEYS = ['CORS_ORIGINS'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

async function appWith(origins?: string): Promise<INestApplication> {
  if (origins === undefined) delete process.env.CORS_ORIGINS
  else process.env.CORS_ORIGINS = origins

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = moduleRef.createNestApplication()
  configureApp(app)
  await app.init()
  return app
}

describe('corsOrigins parsing', () => {
  it('treats an unset value as no origins (CORS off)', async () => {
    const app = await appWith(undefined)
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('splits a comma-separated list and trims spaces', async () => {
    const app = await appWith('http://localhost:5173 , http://127.0.0.1:5173')
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    await app.close()
  })

  it('ignores empty entries from a trailing comma', async () => {
    const app = await appWith('http://localhost:5173,')
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .set('Origin', 'http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    await app.close()
  })
})

describe('preflight', () => {
  it('allows the headers a front-end must send', async () => {
    const app = await appWith('http://localhost:5173')
    const res = await request(app.getHttpServer())
      .options('/api/staged')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-source-name')
      .expect(204)

    const allow = String(res.headers['access-control-allow-headers']).toLowerCase()
    expect(allow).toContain('content-type')
    // Without this the staged file name cannot be sent at all.
    expect(allow).toContain('x-source-name')
    await app.close()
  })

  it('allows the SSE method and exposes Location', async () => {
    const app = await appWith('http://localhost:5173')
    const res = await request(app.getHttpServer())
      .options('/api/print/job-x/events')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204)

    expect(String(res.headers['access-control-allow-methods'])).toContain('GET')
    // A front-end reads the job URL from the 202 response.
    expect(String(res.headers['access-control-expose-headers'])).toContain('Location')
    await app.close()
  })
})
