/**
 * The native RFCOMM addon bridge.
 *
 * ## Why a native addon is required
 *
 * macOS exposes Bluetooth Classic SPP through IOBluetooth, an Objective-C
 * framework. Node has no ObjC bridge, and no maintained pure-JS library speaks
 * Classic SPP. Two paths exist: spawn an external binary, or write a native
 * addon. This project takes the addon path so everything stays in Node.
 *
 * A third path was tried and disproven: opening the `/dev/cu.*` node macOS
 * creates for a paired SPP service. Frames written to that node are byte-perfect
 * (verified byte-for-byte against a working implementation) but the printer
 * that node does not carry this printer's RFCOMM channel. Recorded here so
 * nobody re-tries it.
 *
 * ## The one thing that must not be "simplified"
 *
 * IOBluetooth delivers data via delegate callbacks dispatched by the CFRunLoop
 * of the thread that opened the channel. Node's main thread runs libuv, not
 * CFRunLoop, so a naive addon receives **zero bytes** — which looks exactly like
 * a mute printer. The addon services that run loop from a 5ms uv_timer; see
 * `native/src/rfcomm.mm`. The `length:` delegate parameter must also stay
 * `size_t`; declaring it `UInt16` truncates every frame to length 0.
 *
 * ## Channel number
 *
 * Hard-coded to 1, deliberately. The printer's SDP record for the SPP UUID
 * (0x1101) advertises channel **22**, but 22 fails and 1 works. Any "improvement"
 * that auto-discovers the channel via 0x1101 will break printing.
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { takeFrames } from "./protocol.js";
/**
 * Fallback address, used only when discovery finds nothing.
 *
 * Discovery is the normal path: the printer advertises a name containing
 * "printer", so it can be identified without asking the user for a MAC.
 * Override with `--address` or `PRINTER_ADDRESS` when the name does not match
 * (e.g. renamed device, or a different printer model).
 */
export const FALLBACK_ADDRESS = '';
/**
 * RFCOMM channel carrying the print service.
 * NOT discoverable via SDP — see the note above.
 */
export const RFCOMM_CHANNEL = 1;
/**
 * Total budget for trying candidates during discovery.
 *
 * The printer is normally first in the list (name match), so a healthy setup
 * finishes in well under a second. This bound exists for the unhealthy case:
 * a sleeping printer plus several paired devices used to consume 90s+ before
 * failing, which is longer than most HTTP clients wait.
 */
const DISCOVERY_BUDGET_MS = 20_000;
const require = createRequire(import.meta.url);
/**
 * Path of the compiled addon.
 *
 * Resolved from this file's directory up to the project root, so it works both
 * from `src/printer/` (dev) and `dist/printer/` (built) — both are two levels
 * below the root.
 */
export function addonPath() {
    return resolve(import.meta.dirname, '../../native/build/Release/iobt_rfcomm.node');
}
export function addonBuilt() {
    return existsSync(addonPath());
}
function loadAddon() {
    const path = addonPath();
    if (!existsSync(path)) {
        throw new Error(`原生蓝牙模块尚未编译（缺少 ${path}）。\n` +
            `请运行：npm run build:native`);
    }
    return require(path);
}
/**
 * Candidate printer names, matched case-insensitively.
 *
 * The device advertises itself as e.g. "米家口袋打印机Pro-A2BF". Matching on a
 * name is a heuristic, so it is only used to ORDER candidates — the caller still
 * confirms by speaking the protocol (see `discover`).
 */
const PRINTER_NAME_HINTS = ['printer', '打印', '米家', 'xiaomi', 'hannto'];
/** Score a candidate so the most likely printer is tried first. */
function nameScore(d) {
    const n = d.name.toLowerCase();
    let score = 0;
    if (PRINTER_NAME_HINTS.some((h) => n.includes(h)))
        score += 10;
    if (d.paired)
        score += 2; // paired is more likely usable than merely seen
    if (d.connected)
        score += 1;
    return score;
}
/** Every Bluetooth device the system knows about, best candidates first. */
export function listCandidates() {
    const mod = loadAddon();
    let all = [];
    try {
        all = mod.pairedDevices();
    }
    catch {
        return [];
    }
    return all
        .filter((d) => d.address)
        .sort((a, b) => nameScore(b) - nameScore(a));
}
export class BluetoothLink extends EventEmitter {
    rfcomm = null;
    _mtu = 0;
    verbose;
    address;
    channel;
    /** Bytes not yet forming a whole frame. */
    rx = { data: Buffer.alloc(0) };
    /** Complete frames awaiting consumption. */
    queue = [];
    /** Callbacks waiting for a frame to arrive. */
    waiting = [];
    constructor(opts = {}) {
        super();
        this.verbose = opts.verbose ?? false;
        this.address = opts.address ?? process.env.PRINTER_ADDRESS ?? FALLBACK_ADDRESS;
        this.channel = opts.channel ?? RFCOMM_CHANNEL;
    }
    get mtu() {
        return this._mtu;
    }
    /** The address actually in use (after discovery, if it ran). */
    get resolvedAddress() {
        return this.address;
    }
    get isOpen() {
        return this.rfcomm !== null;
    }
    /**
     * Try the most likely candidates until one accepts an RFCOMM channel.
     *
     * Two details that matter:
     *
     * 1. The successful connection is KEPT, not closed and reopened. Probing with
     *    a throwaway connection and then reconnecting looked equivalent but was
     *    not: the printer needs a moment to recover from the first channel, and
     *    the immediate second connect failed its handshake. Reusing the probe's
     *    channel avoids the round trip entirely.
     *
     * 2. A wrong device fails inside `openRFCOMMChannelSync` — no data is written
     *    and nothing is printed, so probing is safe.
     */
    async openFirstWorking(candidates) {
        const mod = loadAddon();
        // Each candidate can block up to ~15s waiting for the baseband link (the
        // native connect is synchronous and bounded there). With several paired
        // devices that adds up fast — a status probe against a sleeping printer
        // took over 90s and timed out the HTTP client. Cap the whole search.
        const deadline = Date.now() + DISCOVERY_BUDGET_MS;
        for (const c of candidates) {
            if (Date.now() >= deadline) {
                if (this.verbose)
                    process.stderr.write(`  发现超时（预算 ${DISCOVERY_BUDGET_MS}ms 已用完）\n`);
                break;
            }
            if (this.verbose)
                process.stderr.write(`  尝试 ${c.address} (${c.name})…\n`);
            const r = new mod.Rfcomm();
            try {
                r.connect(c.address, this.channel);
            }
            catch {
                // Not this one; try the next. Nothing was written.
                continue;
            }
            // Keep it: wiring the listeners here means connect() can return without
            // touching the device again.
            this.address = c.address;
            this.attach(r);
            if (this.verbose)
                process.stderr.write(`  ✅ ${c.address} 已连接 (mtu=${this._mtu})\n`);
            return true;
        }
        return false;
    }
    /** Wire up an already-connected native channel. */
    attach(r) {
        r.on('data', (buf) => {
            const b = buf;
            if (this.verbose)
                process.stderr.write(`  ◀ RX ${b.length}B\n`);
            this.emit('data', b);
            this.rx.data = this.rx.data.length ? Buffer.concat([this.rx.data, b]) : b;
            const frames = takeFrames(this.rx);
            if (frames.length) {
                this.queue.push(...frames);
                const w = this.waiting;
                this.waiting = [];
                for (const fn of w)
                    fn();
            }
        });
        r.on('closed', () => this.emit('closed'));
        this.rfcomm = r;
        this._mtu = r.mtu();
    }
    /** Baseband connection + RFCOMM channel. Throws with an actionable message. */
    async connect() {
        if (this.rfcomm)
            return;
        loadAddon(); // fail early with a clear message if the module is missing
        if (this.address) {
            // Explicit address: connect once, no probing.
            const mod = loadAddon();
            const r = new mod.Rfcomm();
            try {
                r.connect(this.address, this.channel);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                throw new Error(explainConnectFailure(msg));
            }
            this.attach(r);
            return;
        }
        // No address configured: discover one and keep that connection.
        const candidates = listCandidates();
        if (!candidates.length) {
            throw new Error('找不到任何蓝牙设备。请确认：\n' +
                '  1. 打印机已开机（休眠时需按一下按钮）\n' +
                '  2. 已在「系统设置 → 蓝牙」里与这台电脑配对');
        }
        if (this.verbose) {
            process.stderr.write(`发现 ${candidates.length} 台设备，按可能性排序：\n` +
                candidates.map((c) => `  ${c.address}  ${c.name}`).join('\n') +
                '\n');
        }
        const ok = await this.openFirstWorking(candidates);
        if (!ok) {
            throw new Error('已配对的蓝牙设备都无法打开打印通道。请依次确认：\n' +
                '  1. 打印机已开机（休眠时需按一下按钮唤醒）\n' +
                '  2. 没有另一个本程序实例 / 脚本正占用打印机\n' +
                '     （RFCOMM 通道是独占的，一次只能有一个连接）\n' +
                '  3. 打印机没有被手机上的米家 App 占用\n' +
                '  4. 若仍失败，用 --address <MAC> 指定（格式 aa-bb-cc-dd-ee-ff）');
        }
    }
    /** Write bytes. The addon chunks to the RFCOMM MTU internally. */
    async write(bytes) {
        if (!this.rfcomm)
            throw new Error('蓝牙未连接');
        // writeSync may partially fail under load; retry briefly rather than
        // dropping the transfer.
        for (let attempt = 0; attempt < 250; attempt++) {
            try {
                this.rfcomm.write(bytes);
                return;
            }
            catch (e) {
                if (attempt === 249)
                    throw e;
                await new Promise((r) => setTimeout(r, 20));
            }
        }
    }
    /** The addon writes synchronously, so there is nothing to flush. */
    async drain() { }
    /** Alias kept so the session layer reads naturally. */
    async open() {
        return this.connect();
    }
    /** Take up to `n` whole frames, waiting at most `timeoutMs`. */
    async recv(n = 1, timeoutMs = 15_000) {
        const deadline = Date.now() + timeoutMs;
        while (this.queue.length < n) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            const got = await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    this.waiting = this.waiting.filter((f) => f !== onData);
                    resolve(false);
                }, remaining);
                const onData = () => {
                    clearTimeout(timer);
                    resolve(true);
                };
                this.waiting.push(onData);
            });
            if (!got)
                break;
        }
        const out = this.queue.slice(0, n);
        this.queue = this.queue.slice(out.length);
        return out;
    }
    /** Drop anything buffered — used before starting a fresh exchange. */
    flush() {
        this.queue = [];
        this.rx.data = Buffer.alloc(0);
    }
    async close() {
        const r = this.rfcomm;
        this.rfcomm = null;
        if (!r)
            return;
        try {
            r.close();
        }
        catch {
            /* closing an already-closed channel is not an error worth surfacing */
        }
    }
}
/** Turn an addon error into something a user can act on. */
function explainConnectFailure(msg) {
    if (msg.includes('device not found')) {
        return '找不到打印机。请先在「系统设置 → 蓝牙」里配对打印机。';
    }
    if (msg.includes('printer unreachable') || msg.includes('0xe00002d6')) {
        return '打印机不可达：请确认已开机（休眠后需要按一下按钮唤醒）。';
    }
    if (msg.includes('openRFCOMMChannelSync')) {
        return (`无法打开 RFCOMM 通道 ${RFCOMM_CHANNEL}：${msg}。` +
            '若打印机刚被其他程序连接，等待几秒后重试。');
    }
    return msg;
}
//# sourceMappingURL=bluetooth.js.map