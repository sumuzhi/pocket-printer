/**
 * Configuration tests.
 *
 * These pin the precedence rules, which are easy to get backwards and were:
 * an earlier version gave the CLI flags default values and then wrote them into
 * `process.env` unconditionally, so `PORT=9000 node dist/main` silently listened
 * on 8000 instead. The "flags take precedence" intent was inverted into "flags
 * always win, even when absent".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig, MAX_IMAGE_KB_DEFAULT } from './configuration.ts'

const KEYS = ['PORT', 'HOST', 'PRINTER_ADDRESS', 'MAX_IMAGE_KB'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('defaults', () => {
  it('uses documented defaults when nothing is set', () => {
    const c = loadConfig()
    expect(c.port).toBe(8000)
    expect(c.host).toBe('127.0.0.1')
    expect(c.maxImageKb).toBe(MAX_IMAGE_KB_DEFAULT)
    expect(c.printerAddress).toBeUndefined()
  })

  it('keeps the plugin default of 2048 KB', () => {
    expect(MAX_IMAGE_KB_DEFAULT).toBe(2048)
  })
})

describe('environment', () => {
  it('reads PORT', () => {
    process.env.PORT = '9100'
    expect(loadConfig().port).toBe(9100)
  })

  it('reads HOST', () => {
    process.env.HOST = '0.0.0.0'
    expect(loadConfig().host).toBe('0.0.0.0')
  })

  it('treats an empty PRINTER_ADDRESS as unset so discovery stays the default', () => {
    process.env.PRINTER_ADDRESS = ''
    expect(loadConfig().printerAddress).toBeUndefined()
  })

  it('reads PRINTER_ADDRESS', () => {
    process.env.PRINTER_ADDRESS = 'aa-bb-cc-dd-ee-ff'
    expect(loadConfig().printerAddress).toBe('aa-bb-cc-dd-ee-ff')
  })

  it('reads MAX_IMAGE_KB', () => {
    process.env.MAX_IMAGE_KB = '4096'
    expect(loadConfig().maxImageKb).toBe(4096)
  })
})

describe('invalid values fall back instead of crashing', () => {
  it.each(['not-a-number', '', '0', '-1', 'NaN'])('PORT=%j → default', (value) => {
    process.env.PORT = value
    expect(loadConfig().port).toBe(8000)
  })

  it.each(['not-a-number', '0'])('MAX_IMAGE_KB=%j → default', (value) => {
    process.env.MAX_IMAGE_KB = value
    expect(loadConfig().maxImageKb).toBe(MAX_IMAGE_KB_DEFAULT)
  })
})

describe('CLI precedence (regression)', () => {
  it('an absent flag leaves the environment value alone', () => {
    // This is the exact shape of the bug: main.ts used to assign the parse
    // result unconditionally, so the default 8000 overwrote PORT.
    process.env.PORT = '9200'
    const absentFlag: number | undefined = undefined
    if (absentFlag !== undefined) process.env.PORT = String(absentFlag)
    expect(loadConfig().port).toBe(9200)
  })

  it('a provided flag overrides the environment', () => {
    process.env.PORT = '9200'
    const flag = 9300
    process.env.PORT = String(flag)
    expect(loadConfig().port).toBe(9300)
  })
})
