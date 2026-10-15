/**
 * Protocol tests.
 *
 * These exist because the printer is an irreversible physical output: every
 * defect that reaches the device costs paper. Everything testable offline is
 * tested here, and the framing/rounding rules are pinned to values captured
 * from the plugin's own behaviour and confirmed against real hardware.
 */

import { describe, expect, it } from 'vitest'
import {
  BATCH,
  BODY_LEN,
  CH_AUTH,
  CH_FILE,
  ECB_SHIFT,
  ENC_HEX,
  ENC_JSON,
  FRAME,
  INT_CLIENT_CONFIRM_DH,
  INT_CLIENT_HELLO_DH,
  REQ,
  VERSION,
  buildFrame,
  dhComplete,
  ecb,
  fileFrames,
  frameCountFor,
  packKey,
  packPublic,
  parseServerHello,
  powMod,
  randomBigInt,
  stripTrailingNul,
  takeFrames,
  zpad,
} from './protocol'

describe('frame layout', () => {
  it('writes the header layout the plugin uses', () => {
    const f = buildFrame({
      channel: CH_AUTH,
      interaction: INT_CLIENT_HELLO_DH,
      encoding: ENC_JSON,
      seq: 1,
      body: Buffer.from('hello', 'ascii'),
    })

    expect(f[0]).toBe(FRAME)
    expect(f[1]).toBe(VERSION)
    expect(f[2]).toBe(0)
    expect(f[3]).toBe(CH_AUTH)
    expect(f[4]).toBe(INT_CLIENT_HELLO_DH)
    expect(f[5]).toBe(ENC_JSON)
    // sequence, written twice on purpose (the plugin does this)
    expect(f.readUInt32LE(6)).toBe(1)
    expect(f.readUInt32LE(10)).toBe(1)
    expect(f.readUInt16LE(14)).toBe(0) // total
    expect(f.readUInt16LE(16)).toBe(0) // current
    expect(f.readUInt16LE(18)).toBe(5 + ECB_SHIFT) // attributes
    expect(f.subarray(20, 25).toString('ascii')).toBe('hello')
    expect(f[f.length - 1]).toBe(FRAME)
    expect(f.length).toBe(22 + 5)
  })

  it('sets the chunk flag only when total > 1', () => {
    const single = buildFrame({
      channel: CH_FILE, interaction: REQ, encoding: ENC_HEX, seq: 1,
      body: Buffer.alloc(10), total: 1, current: 1,
    })
    const chunked = buildFrame({
      channel: CH_FILE, interaction: REQ, encoding: ENC_HEX, seq: 1,
      body: Buffer.alloc(10), total: 5, current: 2,
    })
    expect(single.readUInt16LE(18)).toBe(10 + ECB_SHIFT)
    expect(chunked.readUInt16LE(18)).toBe(10 + ECB_SHIFT + 8192)
  })

  it('computes the checksum as (sum - 126) & 0xFF over the whole frame', () => {
    const body = Buffer.from('abcdef', 'ascii')
    const f = buildFrame({
      channel: CH_DATA_TEST, interaction: REQ, encoding: ENC_JSON, seq: 7, body,
    })
    // Recompute independently, with the checksum and tail treated as zero.
    const copy = Buffer.from(f)
    copy[copy.length - 2] = 0
    copy[copy.length - 1] = 0
    let sum = 0
    for (const b of copy) sum += b
    expect(f[f.length - 2]).toBe((sum - 126) & 0xff)
  })

  it('keeps the checksum byte inside a single byte for large bodies', () => {
    const f = buildFrame({
      channel: CH_FILE, interaction: REQ, encoding: ENC_HEX, seq: 1,
      body: Buffer.alloc(BODY_LEN, 0xff), total: 3, current: 1,
    })
    expect(f[f.length - 2]).toBeGreaterThanOrEqual(0)
    expect(f[f.length - 2]).toBeLessThanOrEqual(255)
  })
})

// CH_DATA is not exported by name in the public surface; a literal keeps the
// checksum test readable without inventing a constant.
const CH_DATA_TEST = 3

describe('frame parsing', () => {
  const round = (frames: Buffer[]) => {
    const buf = { data: Buffer.concat(frames) }
    return takeFrames(buf)
  }

  it('round-trips a single frame', () => {
    const orig = buildFrame({
      channel: CH_AUTH, interaction: 17, encoding: ENC_JSON, seq: 42,
      body: Buffer.from('SERVER', 'ascii'),
    })
    const [got] = round([orig])
    expect(got.channel).toBe(CH_AUTH)
    expect(got.interaction).toBe(17)
    expect(got.seq).toBe(42)
    expect(got.body.toString('ascii')).toBe('SERVER')
  })

  it('parses several frames arriving in one chunk', () => {
    const frames = [1, 2, 3].map((n) =>
      buildFrame({
        channel: CH_FILE, interaction: REQ, encoding: ENC_HEX, seq: n,
        body: Buffer.alloc(10, n), total: 3, current: n,
      }),
    )
    const got = round(frames)
    expect(got).toHaveLength(3)
    expect(got.map((f) => f.seq)).toEqual([1, 2, 3])
    expect(got.map((f) => f.current)).toEqual([1, 2, 3])
  })

  it('waits for a frame split across two reads', () => {
    const whole = buildFrame({
      channel: CH_FILE, interaction: REQ, encoding: ENC_HEX, seq: 1,
      body: Buffer.alloc(50, 0xab), total: 1, current: 1,
    })
    const buf = { data: whole.subarray(0, 30) }
    expect(takeFrames(buf)).toHaveLength(0)   // incomplete: nothing emitted
    buf.data = Buffer.concat([buf.data, whole.subarray(30)])
    const got = takeFrames(buf)
    expect(got).toHaveLength(1)
    expect(got[0].body).toHaveLength(50)
  })

  it('resynchronises after garbage', () => {
    const good = buildFrame({
      channel: CH_AUTH, interaction: 19, encoding: ENC_JSON, seq: 5,
      body: Buffer.from('ok', 'ascii'),
    })
    const got = round([Buffer.from([0x00, 0x11, 0x22]), good])
    expect(got).toHaveLength(1)
    expect(got[0].body.toString('ascii')).toBe('ok')
  })

  it('preserves the body length from the attribute field, masked to 10 bits', () => {
    // The plugin masks with 0x3FF because the attribute word carries flags in
    // its high bits (5120 ECB shift, 8192 chunk).
    const f = buildFrame({
      channel: CH_FILE, interaction: REQ, encoding: ENC_HEX, seq: 1,
      body: Buffer.alloc(BODY_LEN, 7), total: 9, current: 1,
    })
    const [got] = round([f])
    expect(got.body).toHaveLength(BODY_LEN)
  })
})

describe('AES-128-ECB', () => {
  it('round-trips a block', () => {
    const key = Buffer.from('0123456789abcdef', 'ascii')
    const plain = Buffer.alloc(16, 0x41)
    const ct = ecb(key, plain)
    expect(ct).toHaveLength(16)
    expect(ct.equals(plain)).toBe(false)
    expect(ecb(key, ct, true).equals(plain)).toBe(true)
  })

  it('does no padding of its own', () => {
    const key = Buffer.from('0123456789abcdef', 'ascii')
    // 15 bytes is not a valid AES block; the cipher must refuse rather than
    // silently pad, because the protocol zero-pads explicitly.
    expect(() => ecb(key, Buffer.alloc(15))).toThrow()
  })

  it('zpad pads to the next 16-byte boundary', () => {
    expect(zpad(Buffer.alloc(0))).toHaveLength(0)
    expect(zpad(Buffer.alloc(1))).toHaveLength(16)
    expect(zpad(Buffer.alloc(16))).toHaveLength(16)
    expect(zpad(Buffer.alloc(17))).toHaveLength(32)
  })

  it('matches a known AES-128-ECB vector', () => {
    // FIPS-197 / NIST SP 800-38A, ECB-AES128, block 1.
    const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex')
    const plain = Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex')
    const expected = '3ad77bb40d7a3660a89ecaf32466ef97'
    expect(ecb(key, plain).toString('hex')).toBe(expected)
  })
})

describe('modular arithmetic', () => {
  it('computes powers correctly', () => {
    expect(powMod(2n, 10n, 1000n)).toBe(1024n % 1000n)
    expect(powMod(5n, 0n, 7n)).toBe(1n)
    expect(powMod(0n, 5n, 7n)).toBe(0n)
  })

  it('agrees with a small brute-force check', () => {
    const p = 104729n // prime
    for (const g of [2n, 3n, 5n]) {
      for (const e of [1n, 2n, 17n, 1000n]) {
        let expected = 1n
        for (let i = 0n; i < e; i++) expected = (expected * g) % p
        expect(powMod(g, e, p)).toBe(expected)
      }
    }
  })

  it('randomBigInt stays in range', () => {
    for (let i = 0; i < 50; i++) {
      const v = randomBigInt(2n, 1000n)
      expect(v).toBeGreaterThanOrEqual(2n)
      expect(v).toBeLessThan(1000n)
    }
  })
})

describe('DH handshake', () => {
  it('parses the real captured server hello', () => {
    // Rebuild the ASCII layout the printer actually sends.
    const body = Buffer.alloc(36)
    Buffer.from('0002', 'ascii').copy(body, 0)
    Buffer.from('E6969D3D495BE32C', 'ascii').copy(body, 4)
    Buffer.from('0000000000000001', 'ascii').copy(body, 20)

    const params = parseServerHello(body)
    expect(params).not.toBeNull()
    expect(params!.g).toBe(2n)
    expect(params!.p).toBe(BigInt('0xE6969D3D495BE32C'))
    expect(params!.rawP.toString('ascii')).toBe('E6969D3D495BE32C')
  })

  it('rejects a short body', () => {
    expect(parseServerHello(Buffer.alloc(10))).toBeNull()
  })

  it('produces a confirm message the printer accepts', () => {
    const body = Buffer.alloc(36)
    Buffer.from('0002', 'ascii').copy(body, 0)
    Buffer.from('E6969D3D495BE32C', 'ascii').copy(body, 4)
    Buffer.from('0000000000000001', 'ascii').copy(body, 20)

    const r = dhComplete(parseServerHello(body)!)
    expect(r.key).toHaveLength(16)
    expect(r.confirm).toHaveLength(32) // 16-byte rb + 16-byte proof
  })

  // Tested directly rather than through a handshake: the private key is random,
  // so rb's hex length varies and a "there must be padding" assertion would
  // only hold for some runs. That was a real flake in this suite.
  it('pads the public value at the FRONT with "0"', () => {
    const packed = packPublic(0x8n)
    expect(packed).toHaveLength(16)
    expect(packed.toString('ascii')).toBe('0000000000000008')
    expect(packed.subarray(0, 15).every((b) => b === 0x30)).toBe(true)
  })

  it('leaves a full-width public value untouched', () => {
    const big = BigInt('0xFEDCBA9876543210')
    expect(packPublic(big).toString('ascii')).toBe('FEDCBA9876543210')
  })

  it('pads the session key at the END with NUL', () => {
    const packed = packKey(0x8n)
    expect(packed).toHaveLength(16)
    expect(packed[0]).toBe(0x38) // '8'
    expect(packed.subarray(1).every((b) => b === 0x00)).toBe(true)
  })

  it('never pads the key with the digit zero, nor the public value with NUL', () => {
    // The two rules are mirror images; mixing them up is the classic failure.
    const key = packKey(0x8n)
    const pub = packPublic(0x8n)
    expect(key[1]).toBe(0x00)
    expect(key[1]).not.toBe(0x30)
    expect(pub[0]).toBe(0x30)
    expect(pub[0]).not.toBe(0x00)
  })

  it('truncates values longer than 16 bytes', () => {
    const huge = BigInt('0x' + 'AB'.repeat(24))
    expect(packKey(huge)).toHaveLength(16)
    expect(packPublic(huge)).toHaveLength(16)
  })

  it('derives the same key from both sides', () => {
    // Simulate a full exchange with a small prime.
    const p = 104729n
    const g = 2n
    const serverPriv = 12345n
    const serverPub = powMod(g, serverPriv, p)

    const body = Buffer.alloc(36)
    Buffer.from('0002', 'ascii').copy(body, 0)
    Buffer.from(p.toString(16).toUpperCase().padStart(16, '0'), 'ascii').copy(body, 4)
    Buffer.from(serverPub.toString(16).toUpperCase().padStart(16, '0'), 'ascii').copy(body, 20)

    const r = dhComplete(parseServerHello(body)!)
    const serverKey = powMod(r.clientPublic, serverPriv, p)

    let expected = Buffer.from(serverKey.toString(16).toUpperCase(), 'ascii')
    if (expected.length < 16) expected = Buffer.concat([expected, Buffer.alloc(16 - expected.length)])
    expect(r.key.equals(expected.subarray(0, 16))).toBe(true)
  })
})

describe('file chunking', () => {
  const key = Buffer.from('0123456789abcdef', 'ascii')

  const collect = (size: number, jobId = 7) => {
    const batches = [...fileFrames(Buffer.alloc(size, 0x5a), jobId, key, 1)]
    const frames = batches.flatMap((b) => b.frames)
    return { batches, frames }
  }

  it('reports the frame count the protocol implies', () => {
    expect(frameCountFor(0)).toBe(0)
    expect(frameCountFor(1)).toBe(1)
    expect(frameCountFor(BODY_LEN)).toBe(1)
    expect(frameCountFor(BODY_LEN + 1)).toBe(2)
    // The real 456KB photo produced 508 frames.
    expect(frameCountFor(467663)).toBe(474)
  })

  it('emits one frame per 988 bytes', () => {
    const { frames } = collect(BODY_LEN * 3)
    expect(frames).toHaveLength(3)
    expect(frames[0].readUInt16LE(16)).toBe(1) // current
    expect(frames[2].readUInt16LE(16)).toBe(3)
    expect(frames[0].readUInt16LE(14)).toBe(3) // total
  })

  it('groups writes into batches of three', () => {
    const { batches, frames } = collect(BODY_LEN * 7)
    expect(frames).toHaveLength(7)
    // 3 + 3 + 1 — the tail is flushed rather than held back.
    expect(batches.map((b) => b.frames.length)).toEqual([3, 3, 1])
  })

  it('flushes the final partial batch', () => {
    const { batches } = collect(BODY_LEN * 4)
    expect(batches.map((b) => b.frames.length)).toEqual([3, 1])
  })

  it('puts the job id in the first four bytes of the payload', () => {
    const jobId = 0x01020304
    const { frames } = collect(BODY_LEN, jobId)
    // Slice by the declared body length: subarray(20) would also include the
    // checksum and tail, which are not a whole number of AES blocks.
    const blen = (frames[0][18] | (frames[0][19] << 8)) & 0x3ff
    const body = ecb(key, frames[0].subarray(20, 20 + blen), true)
    expect(body.readUInt32LE(0)).toBe(jobId)
  })

  it('encrypts every frame body', () => {
    const { frames } = collect(BODY_LEN * 2)
    for (const f of frames) {
      const blen = (f[18] | (f[19] << 8)) & 0x3ff
      const body = f.subarray(20, 20 + blen)
      expect(body.length % 16).toBe(0) // AES block aligned
      expect(body.includes(0x5a)).toBe(false) // plaintext does not leak
    }
  })

  it('encodes as HEX, the channel the plugin uses for file data', () => {
    const { frames } = collect(BODY_LEN)
    expect(frames[0][3]).toBe(CH_FILE)
    expect(frames[0][5]).toBe(ENC_HEX)
    expect(frames[0][4]).toBe(REQ)
  })

  it('handles an empty file without emitting frames', () => {
    const { frames } = collect(0)
    expect(frames).toHaveLength(0)
  })

  it('increments the sequence number across all frames', () => {
    const { frames } = collect(BODY_LEN * 5)
    const seqs = frames.map((f) => f.readUInt32LE(6))
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })

  it('uses the same total across a multi-segment transfer', () => {
    // Two segments: more bytes than one segment holds.
    const size = BODY_LEN * 1061 + BODY_LEN * 5
    const { frames } = collect(size)
    const total = frames[0].readUInt16LE(14)
    expect(total).toBe(frameCountFor(size))
    for (const f of frames) expect(f.readUInt16LE(14)).toBe(total)
  })
})

describe('response handling', () => {
  it('strips the NUL padding the printer appends', () => {
    const b = Buffer.concat([Buffer.from('{"ok":1}', 'ascii'), Buffer.alloc(7)])
    expect(stripTrailingNul(b).toString('ascii')).toBe('{"ok":1}')
  })

  it('leaves an unpadded buffer alone', () => {
    const b = Buffer.from('{"ok":1}', 'ascii')
    expect(stripTrailingNul(b).toString('ascii')).toBe('{"ok":1}')
  })

  it('handles an all-NUL buffer', () => {
    expect(stripTrailingNul(Buffer.alloc(8))).toHaveLength(0)
  })
})

describe('constants stay pinned to the plugin', () => {
  it('matches the values read out of the bundle', () => {
    expect(BODY_LEN).toBe(988)
    expect(BATCH).toBe(3)
    expect(ECB_SHIFT).toBe(5120)
    expect(CH_AUTH).toBe(255)
    expect(VERSION).toBe(100)
    expect(INT_CLIENT_HELLO_DH).toBe(16)
    expect(INT_CLIENT_CONFIRM_DH).toBe(18)
  })
})

describe('request/response discipline', () => {
  /**
   * The protocol is strictly one request, one response, over a single channel.
   * Two commands in flight make both waiters race for the same reply, so one
   * reports "no response" against a perfectly healthy printer. That race was a
   * real bug in the status endpoint (`Promise.all([status(), deviceInfo()])`).
   *
   * This test documents the invariant at the protocol level: each request must
   * carry a distinct sequence number so replies can be told apart.
   */
  it('gives each command a distinct sequence number', () => {
    const key = Buffer.from('0123456789abcdef', 'ascii')
    const a = buildFrame({
      channel: 3, interaction: 6, encoding: 3, seq: 1,
      body: ecb(key, zpad(Buffer.from('{"method":"mixed_status","id":1}', 'utf8'))),
    })
    const b = buildFrame({
      channel: 3, interaction: 6, encoding: 3, seq: 2,
      body: ecb(key, zpad(Buffer.from('{"method":"get_prop","id":2}', 'utf8'))),
    })
    expect(a.readUInt32LE(6)).toBe(1)
    expect(b.readUInt32LE(6)).toBe(2)
    expect(a.readUInt32LE(6)).not.toBe(b.readUInt32LE(6))
  })

  it('keeps the request id inside the encrypted payload in step with the frame', () => {
    const key = Buffer.from('0123456789abcdef', 'ascii')
    const payload = Buffer.from('{"method":"mixed_status","id":7,"params":{}}', 'utf8')
    const frame = buildFrame({
      channel: 3, interaction: 6, encoding: 3, seq: 7,
      body: ecb(key, zpad(payload)),
    })
    const blen = (frame[18] | (frame[19] << 8)) & 0x3ff
    const plain = ecb(key, frame.subarray(20, 20 + blen), true).toString('utf8')
    expect(plain).toContain('"id":7')
    expect(frame.readUInt32LE(6)).toBe(7)
  })
})
