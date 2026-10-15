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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var PrinterService_1;
import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { BluetoothLink, addonBuilt, addonPath, listCandidates } from "./bluetooth.js";
import { PrintSession, PrinterError, JOB_TYPE } from "./session.js";
import { frameCountFor } from "./protocol.js";
/** How long a finished job stays queryable before being pruned. */
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 50;
let PrinterService = PrinterService_1 = class PrinterService {
    log = new Logger(PrinterService_1.name);
    jobs = new Map();
    /** Serialises all access to the printer. See class comment (1). */
    chain = Promise.resolve();
    /** The currently running job id, if any. */
    activeJob = null;
    /**
     * Run `fn` with exclusive access to the printer.
     *
     * Tasks are chained rather than rejected when busy, so a status probe issued
     * during a print simply waits its turn instead of failing. The connection is
     * opened per task: RFCOMM cannot be held open indefinitely between commands
     * without the printer eventually dropping it.
     */
    run(label, fn) {
        const task = this.chain.then(async () => {
            if (!addonBuilt()) {
                throw new PrinterError(`原生蓝牙模块未编译。请运行：npm run build:native（缺少 ${addonPath()}）`);
            }
            const link = new BluetoothLink();
            const session = new PrintSession(link, false);
            try {
                await session.connect();
                return await fn(session, link.resolvedAddress);
            }
            finally {
                await session.close().catch(() => { });
            }
        });
        // Keep the chain alive even if this task fails, or every later task would
        // reject immediately with the previous error.
        this.chain = task.catch(() => { });
        return task.catch((e) => {
            this.log.warn(`${label} 失败：${e instanceof Error ? e.message : String(e)}`);
            throw e;
        });
    }
    // ------------------------------------------------------------------ probes
    async status() {
        if (!addonBuilt()) {
            return {
                available: false,
                reachable: false,
                handshakeOk: false,
                message: `原生蓝牙模块未编译，请运行：npm run build:native`,
            };
        }
        try {
            return await this.run('status', async (s, address) => {
                // SERIAL, deliberately. The protocol is one-request-one-response; two
                // commands in flight make both waiters race for the same reply.
                const st = await s.status();
                const info = await s.deviceInfo();
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
                };
            });
        }
        catch (e) {
            return {
                available: true,
                reachable: false,
                handshakeOk: false,
                message: e instanceof Error ? e.message : String(e),
            };
        }
    }
    /** Bluetooth devices the system knows about; no connection is made. */
    candidates() {
        if (!addonBuilt())
            return [];
        try {
            return listCandidates().map((c) => ({ address: c.address, name: c.name }));
        }
        catch {
            return [];
        }
    }
    /** True while a print job is in flight. */
    get busy() {
        return this.activeJob;
    }
    // ------------------------------------------------------------------- jobs
    /**
     * Start printing a staged file. Returns immediately with a job record.
     *
     * The caller polls `getJob(id)` for progress. This replaces the old blocking
     * `POST /api/print` that held the request open for ~75 seconds.
     */
    startPrint(imagePath, sourceName) {
        if (this.activeJob) {
            throw new PrinterError(`打印机忙：正在处理任务 ${this.activeJob}`);
        }
        const job = {
            id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            sourceName,
            bytes: 0,
            frames: 0,
            state: 'queued',
            progress: 0,
            createdAt: Date.now(),
        };
        this.jobs.set(job.id, job);
        this.prune();
        this.activeJob = job.id;
        // Fire and forget: the job's own record carries the outcome.
        void this.executeJob(job, imagePath).finally(() => {
            if (this.activeJob === job.id)
                this.activeJob = null;
        });
        return job;
    }
    async executeJob(job, imagePath) {
        try {
            const file = await readFile(imagePath);
            job.bytes = file.length;
            job.frames = frameCountFor(file.length);
            job.startedAt = Date.now();
            job.state = 'transferring';
            const result = await this.run('print', async (s) => {
                const before = await s.status();
                if (before.category && before.category !== 'idle') {
                    throw new PrinterError(`打印机当前状态为 ${before.category}，不是空闲，已中止`);
                }
                const printerJobId = await s.createJob(file.length, 1, JOB_TYPE.PHOTO);
                job.printerJobId = printerJobId;
                job.progress = 0.1;
                await s.sendFile(file, printerJobId);
                job.progress = 0.5;
                job.state = 'printing';
                // Poll until finished; report progress from the printer's own counters.
                const final = await s.waitForJob(printerJobId, {
                    timeoutMs: 180_000,
                    intervalMs: 3_000,
                    onTick: (t) => {
                        job.state = t.state === 'finished' ? 'finished' : 'printing';
                        job.printTimeMs = t.printTime;
                        // The transfer is done by now, so progress reflects printing.
                        job.progress = 0.5;
                    },
                });
                return { printerJobId, final };
            });
            job.state = result.final.state === 'finished' ? 'finished' : 'failed';
            if (job.state === 'failed') {
                job.error = `任务未确认完成（${result.final.state}）`;
            }
            job.progress = 1;
            job.printTimeMs = result.final.printTime;
            job.finishedAt = Date.now();
            this.log.log(`任务 ${job.id} 结束：${job.state}（打印机任务 ${result.printerJobId}）`);
        }
        catch (e) {
            job.state = 'failed';
            job.error = e instanceof Error ? e.message : String(e);
            job.finishedAt = Date.now();
            this.log.warn(`任务 ${job.id} 失败：${job.error}`);
        }
    }
    getJob(id) {
        return this.jobs.get(id);
    }
    listJobs() {
        return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    }
    /** Drop old finished jobs so the map cannot grow without bound. */
    prune() {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            const done = job.state === 'finished' || job.state === 'failed' || job.state === 'cancelled';
            if (done && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
                this.jobs.delete(id);
            }
        }
        if (this.jobs.size > MAX_JOBS) {
            const finished = [...this.jobs.values()]
                .filter((j) => j.finishedAt)
                .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
            for (const j of finished.slice(0, this.jobs.size - MAX_JOBS)) {
                this.jobs.delete(j.id);
            }
        }
    }
};
PrinterService = PrinterService_1 = __decorate([
    Injectable()
], PrinterService);
export { PrinterService };
//# sourceMappingURL=printer.service.js.map