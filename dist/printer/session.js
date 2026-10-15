/**
 * A printing session: handshake, commands, file transfer.
 *
 * The flow mirrors the plugin's own sequence, confirmed on real hardware:
 *
 *   connect → handshake → mixed_status → print_job → sendFile → poll job_info
 *
 * This is genuinely async, so a 70-second print does not block a thread;
 * callers can await progress and report it.
 */
import { BATCH, BODY_LEN, CH_AUTH, CH_DATA, ENC_JSON, INT_CLIENT_CONFIRM_DH, INT_CLIENT_HELLO_DH, INT_SERVER_CONFIRM_DH, INT_SERVER_HELLO_DH, REQ, buildFrame, dhComplete, ecb, fileFrames, frameCountFor, parseServerHello, stripTrailingNul, zpad, } from "./protocol.js";
/** Job types, read from the plugin bundle. */
export const JOB_TYPE = {
    PHOTO: 0,
    ID_CARDING: 1,
    ID_PHOTO: 2,
    DOCUMENT: 3,
    SERVICE: 4,
    AR: 9,
    PHONOGRAPH: 10,
    JIGSAW: 11,
    SPLIT: 12,
    HEADSHOT: 13,
    LABEL: 14,
    CARD: 15,
    FIRMWARE: 100,
};
export class PrinterError extends Error {
}
export class PrintSession {
    link;
    seq = 0;
    key = Buffer.alloc(16);
    verbose;
    constructor(link, verbose = false) {
        this.link = link;
        this.verbose = verbose;
    }
    nextSeq() {
        this.seq += 1;
        return this.seq;
    }
    /** Open the port and complete the DH handshake. */
    async connect() {
        await this.link.open();
        await this.handshake();
    }
    async handshake() {
        const hello = buildFrame({
            channel: CH_AUTH,
            interaction: INT_CLIENT_HELLO_DH,
            encoding: ENC_JSON,
            seq: this.nextSeq(),
            body: Buffer.from('hello', 'ascii'),
        });
        await this.link.write(hello);
        const [reply] = await this.link.recv(1, 10_000);
        if (!reply || reply.channel !== CH_AUTH || reply.interaction !== INT_SERVER_HELLO_DH) {
            throw new PrinterError('未收到 SERVER_HELLO_DH —— 打印机未响应握手');
        }
        const params = parseServerHello(reply.body);
        if (!params) {
            throw new PrinterError('DH 参数异常，无法继续');
        }
        if (this.verbose) {
            process.stderr.write(`← SERVER_HELLO_DH g=${params.g} p=${params.p.toString(16).toUpperCase()}\n`);
        }
        const dh = dhComplete(params);
        this.key = dh.key;
        await this.link.write(buildFrame({
            channel: CH_AUTH,
            interaction: INT_CLIENT_CONFIRM_DH,
            encoding: ENC_JSON,
            seq: this.nextSeq(),
            body: dh.confirm,
        }));
        const [confirm] = await this.link.recv(1, 10_000);
        if (!confirm || confirm.channel !== CH_AUTH || confirm.interaction !== INT_SERVER_CONFIRM_DH) {
            throw new PrinterError('未收到 CONFIRM 回复');
        }
        const text = stripTrailingNul(confirm.body).toString('ascii');
        if (text.toLowerCase() !== 'ok') {
            // "nok" almost always means the derived session key is wrong, which in
            // turn almost always means one of the two padding rules got swapped.
            throw new PrinterError(`握手被拒绝：${JSON.stringify(text)}` +
                (text.toLowerCase() === 'nok' ? '（会话密钥不符：检查 DH 两处补位规则）' : ''));
        }
    }
    /** Send an encrypted JSON command and parse the JSON reply. */
    async command(method, params = {}) {
        const my = this.nextSeq();
        const payload = JSON.stringify({ method, id: my, params });
        await this.link.write(buildFrame({
            channel: CH_DATA,
            interaction: REQ,
            encoding: ENC_JSON,
            seq: my,
            body: ecb(this.key, zpad(Buffer.from(payload, 'utf8'))),
        }));
        const [frame] = await this.link.recv(1);
        if (!frame)
            throw new PrinterError(`命令 ${method} 无响应`);
        const plain = stripTrailingNul(ecb(this.key, frame.body, true)).toString('utf8');
        try {
            return JSON.parse(plain);
        }
        catch {
            throw new PrinterError(`命令 ${method} 返回的不是 JSON：${plain.slice(0, 120)}`);
        }
    }
    async status() {
        const r = await this.command('mixed_status');
        const body = (r.result ?? {});
        return {
            category: body.category,
            battery: body['battery-level'],
            error: body.error,
            sensor: body.sensor,
            raw: r,
        };
    }
    async deviceInfo() {
        const r = await this.command('get_prop', ['device_info']);
        const list = Array.isArray(r.result) ? r.result : [];
        const d = list[0] ?? {};
        return {
            fw: d.fw_ver,
            hw: d.hw_ver,
            model: d.model,
            sn: d.sn_all,
            sku: d.sku,
            mac: d.mac,
            did: d.did,
            raw: d,
        };
    }
    async jobInfo(jobId) {
        const r = await this.command('job_info', [jobId]);
        const list = Array.isArray(r.result) ? r.result : [];
        const d = list[0] ?? {};
        return {
            jobId,
            state: d.job_state ?? 'unknown',
            copies: d.prt_copies,
            transferTime: d.transfer_time,
            printTime: d.print_time,
        };
    }
    /** Upload the image for a job the printer has already accepted. */
    async sendFile(file, jobId) {
        for (const batch of fileFrames(file, jobId, this.key, this.seq)) {
            const bytes = Buffer.concat(batch.frames);
            await this.link.write(bytes);
            this.seq += batch.frames.length;
        }
        await this.link.drain();
    }
    /** Ask the printer to create a job. Returns its id. */
    async createJob(bytes, copies = 1, jobType = JOB_TYPE.PHOTO) {
        const r = await this.command('print_job', {
            file_size: bytes,
            copies,
            job_type: jobType,
            channel: 576,
        });
        const result = r.result;
        const id = result?.job_id;
        if (typeof id !== 'number') {
            throw new PrinterError(`print_job 未返回 job_id：${JSON.stringify(r).slice(0, 160)}`);
        }
        return id;
    }
    /** Poll until the job finishes, or the deadline passes. */
    async waitForJob(jobId, opts = {}) {
        const timeout = opts.timeoutMs ?? 180_000;
        const interval = opts.intervalMs ?? 5_000;
        const deadline = Date.now() + timeout;
        let last = { jobId, state: 'unknown' };
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, interval));
            try {
                last = await this.jobInfo(jobId);
            }
            catch (e) {
                // A transient read failure during a 70-second print is not fatal; keep
                // polling rather than declaring the job failed.
                if (this.verbose)
                    process.stderr.write(`  job_info 暂时失败：${e.message}\n`);
                continue;
            }
            opts.onTick?.(last);
            if (last.state === 'finished')
                return last;
        }
        return last;
    }
    async close() {
        await this.link.close();
    }
}
/** Expected frame count for a file — exposed for progress reporting. */
export { frameCountFor, BODY_LEN, BATCH };
//# sourceMappingURL=session.js.map