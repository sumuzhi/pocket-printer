/**
 * The printer's wire protocol, recovered from the Mi Home app's printer plugin.
 *
 * This module is deliberately pure: no I/O, no timers, no Bluetooth. Everything
 * here can be tested offline, which matters because the printer is an
 * irreversible physical output — the more of it we can verify without paper, the
 * better.
 *
 * Frame layout (22-byte header + body + checksum + tail):
 *
 *   0      0x7E                    FRAME
 *   1      100                     VERSION
 *   2      0
 *   3      channel                 255 auth / 3 data / 4 file
 *   4      interaction type        6 request / 16,17,18,19 DH / ...
 *   5      encoding                2 hex / 3 json
 *   6..9   sequence (u32 LE)
 *   10..13 sequence (u32 LE, repeated — the plugin does this; kept as-is)
 *   14..15 total (u16 LE)
 *   16..17 current (u16 LE)
 *   18..19 attributes (u16 LE)      body.length + 5120 (+8192 when chunked)
 *   20..   body
 *   -2     checksum = (sum of all bytes with -2 and -1 zero) - 126
 *   -1     0x7E
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export const FRAME = 0x7e;
export const VERSION = 100;
export const CH_AUTH = 255;
export const CH_DATA = 3;
export const CH_FILE = 4;
export const REQ = 6;
export const INT_CLIENT_HELLO_DH = 16;
export const INT_SERVER_HELLO_DH = 17;
export const INT_CLIENT_CONFIRM_DH = 18;
export const INT_SERVER_CONFIRM_DH = 19;
export const ENC_HEX = 2;
export const ENC_JSON = 3;
/** Attribute flag constants, read out of the plugin. */
export const ECB_SHIFT = 5120;
export const CHUNK_FLAG = 8192;
/** Bytes of file payload per frame. */
export const BODY_LEN = 988;
/** Frames coalesced into a single write. */
export const BATCH = 3;
/** Frames per transfer segment (the plugin's 1061). */
export const SEGMENT_FRAMES = 1061;
// ------------------------------------------------------------------ framing
function putU16(buf, off, v) {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
}
function putU32(buf, off, v) {
    for (let i = 0; i < 4; i++)
        buf[off + i] = (v >>> (8 * i)) & 0xff;
}
export function buildFrame(opts) {
    const { channel, interaction, encoding, seq, body } = opts;
    const total = opts.total ?? 0;
    const current = opts.current ?? 0;
    const f = Buffer.alloc(22 + body.length);
    f[0] = FRAME;
    f[1] = VERSION;
    f[2] = 0;
    f[3] = channel;
    f[4] = interaction;
    f[5] = encoding;
    putU32(f, 6, seq);
    putU32(f, 10, seq);
    putU16(f, 14, total);
    putU16(f, 16, current);
    let attr = body.length + ECB_SHIFT;
    if (total > 1)
        attr += CHUNK_FLAG;
    putU16(f, 18, attr);
    body.copy(f, 20);
    let sum = 0;
    for (const b of f)
        sum += b;
    f[f.length - 2] = (sum - 126) & 0xff;
    f[f.length - 1] = FRAME;
    return f;
}
/**
 * Pull complete frames out of a receive buffer, mutating it.
 *
 * `Buffer` is used rather than an array of numbers because frames are sliced
 * constantly; a naive array copy per byte would be needlessly slow for a
 * 500KB transfer.
 */
export function takeFrames(buf) {
    const out = [];
    let d = buf.data;
    while (d.length >= 22) {
        if (d[0] !== FRAME) {
            // Resynchronise on the next frame marker; drop everything before it.
            const next = d.indexOf(FRAME, 1);
            if (next < 0) {
                d = Buffer.alloc(0);
                break;
            }
            d = d.subarray(next);
            continue;
        }
        const blen = (d[18] | (d[19] << 8)) & 0x3ff;
        const need = 22 + blen;
        if (blen <= 0 || d.length < need)
            break;
        out.push({
            channel: d[3],
            interaction: d[4],
            encoding: d[5],
            seq: (d[6] | (d[7] << 8) | (d[8] << 16) | (d[9] << 24)) >>> 0,
            total: d[14] | (d[15] << 8),
            current: d[16] | (d[17] << 8),
            body: Buffer.from(d.subarray(20, 20 + blen)),
        });
        d = d.subarray(need);
    }
    buf.data = d;
    return out;
}
// ------------------------------------------------------------------- crypto
/**
 * AES-128-ECB with NO padding.
 *
 * The printer expects zero-padding to the block boundary, not PKCS#7, so
 * callers pad explicitly via `zpad` and the cipher must not pad on its own.
 */
export function ecb(key, data, decrypt = false) {
    const c = decrypt
        ? createDecipheriv('aes-128-ecb', key, null)
        : createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
}
/** Zero-pad to a multiple of 16. */
export function zpad(b) {
    const rem = b.length % 16;
    if (rem === 0)
        return b;
    return Buffer.concat([b, Buffer.alloc(16 - rem)]);
}
/** Strip trailing NUL bytes — how the plugin terminates JSON responses. */
export function stripTrailingNul(b) {
    let end = b.length;
    while (end > 0 && b[end - 1] === 0)
        end--;
    return b.subarray(0, end);
}
// ---------------------------------------------------------------------- DH
/**
 * Modular exponentiation.
 *
 * Uses BigInt rather than hand-rolled 64-bit arithmetic: the values fit
 * comfortably, and hand-rolling modular arithmetic is exactly the kind of thing
 * that silently produces a wrong shared secret.
 */
export function powMod(base, exp, mod) {
    let result = 1n;
    let b = base % mod;
    let e = exp;
    while (e > 0n) {
        if (e & 1n)
            result = (result * b) % mod;
        b = (b * b) % mod;
        e >>= 1n;
    }
    return result;
}
/** Uniform random BigInt in [min, max). */
export function randomBigInt(min, max) {
    const range = max - min;
    if (range <= 0n)
        throw new Error('empty range');
    const bytes = Math.ceil(range.toString(2).length / 8) + 8;
    for (;;) {
        const candidate = BigInt('0x' + randomBytes(bytes).toString('hex')) % range;
        if (candidate >= 0n)
            return min + candidate;
    }
}
/**
 * Parse SERVER_HELLO_DH.
 *
 * G/P/RA are ASCII HEX TEXT, not packed integers — decoding them as binary
 * produces a valid-looking but wrong number, and the printer answers `nok`.
 */
export function parseServerHello(body) {
    if (body.length < 36)
        return null;
    const text = (start, end) => {
        let s = '';
        for (let i = start; i < end; i++) {
            if (body[i] === 0)
                break;
            s += String.fromCharCode(body[i]);
        }
        return s;
    };
    const toBig = (s) => (s ? BigInt('0x' + s) : 0n);
    const g = toBig(text(0, 4));
    const p = toBig(text(4, 20));
    const serverPublic = toBig(text(20, 36));
    if (g <= 1n || p <= 2n)
        return null;
    return { g, p, serverPublic, rawP: Buffer.from(body.subarray(4, 20)) };
}
/**
 * The session key: ASCII hex of `shared`, padded at the END with 0x00 (NUL).
 *
 * Split out because the two padding rules are the easiest thing in this whole
 * protocol to get backwards, and a swapped rule produces the same symptom as a
 * wrong key (`nok`) with no further clue. Being pure functions, they can be
 * tested directly rather than only through a random handshake.
 */
export function packKey(shared) {
    let kb = Buffer.from(shared.toString(16).toUpperCase(), 'ascii');
    if (kb.length < 16)
        kb = Buffer.concat([kb, Buffer.alloc(16 - kb.length)]);
    return kb.subarray(0, 16);
}
/** The client's public value: ASCII hex, padded at the FRONT with '0' (0x30). */
export function packPublic(clientPublic) {
    let rbb = Buffer.from(clientPublic.toString(16).toUpperCase(), 'ascii');
    if (rbb.length < 16) {
        rbb = Buffer.concat([Buffer.alloc(16 - rbb.length, 0x30), rbb]);
    }
    return rbb.subarray(0, 16);
}
/**
 * Complete the DH exchange.
 *
 * Two padding rules that are easy to get backwards, both read from the plugin:
 *   rb (the public value sent to the printer) is padded with '0' at the FRONT
 *   k  (the session key)                      is padded with 0x00 at the END
 * Swapping them made the printer reply `nok`.
 */
export function dhComplete(params) {
    const { g, p, serverPublic } = params;
    const privateKey = randomBigInt(2n, p - 1n);
    const clientPublic = powMod(g, privateKey, p);
    const shared = powMod(serverPublic, privateKey, p);
    const key = packKey(shared);
    const rbb = packPublic(clientPublic);
    // Proof that we derived the same key: AES over the server's own P bytes,
    // exactly as they arrived (see DhParams.rawP).
    const proof = ecb(key, zpad(params.rawP)).subarray(0, 16);
    return { key, confirm: Buffer.concat([rbb, proof]), privateKey, clientPublic };
}
/**
 * Split the image into frames ready to write.
 *
 * Yields frames grouped into write batches: every `BATCH` frames, or at the end
 * of each segment, the accumulated buffer is flushed. Batching matters —
 * writing 1061 tiny RFCOMM packets is far slower than writing fewer large ones.
 */
export function* fileFrames(file, jobId, key, seqStart) {
    // An empty file has nothing to send. Without this guard the `Math.max(1, …)`
    // below would emit one frame carrying only a job id, which the printer would
    // treat as a zero-length transfer.
    if (file.length === 0)
        return;
    const seg = BODY_LEN * SEGMENT_FRAMES;
    const total = Math.ceil(file.length / BODY_LEN);
    const segments = Math.max(1, Math.ceil(file.length / seg));
    let seq = seqStart;
    let current = 0;
    for (let i = 0; i < segments; i++) {
        const start = i * seg;
        const part = file.subarray(start, Math.min(file.length, start + seg));
        const framesInSegment = Math.max(1, Math.ceil(part.length / BODY_LEN));
        let batch = [];
        for (let j = 0; j < framesInSegment; j++) {
            current++;
            const chunk = part.subarray(j * BODY_LEN, Math.min(part.length, (j + 1) * BODY_LEN));
            const payload = Buffer.alloc(4 + chunk.length);
            payload[0] = jobId & 0xff;
            payload[1] = (jobId >>> 8) & 0xff;
            payload[2] = (jobId >>> 16) & 0xff;
            payload[3] = (jobId >>> 24) & 0xff;
            chunk.copy(payload, 4);
            batch.push(buildFrame({
                channel: CH_FILE,
                interaction: REQ,
                encoding: ENC_HEX,
                seq: seq++,
                body: ecb(key, zpad(payload)),
                total,
                current,
            }));
            if (batch.length >= BATCH || j === framesInSegment - 1) {
                yield { frames: batch, current, total };
                batch = [];
            }
        }
    }
}
export function frameCountFor(bytes) {
    return Math.ceil(bytes / BODY_LEN);
}
//# sourceMappingURL=protocol.js.map