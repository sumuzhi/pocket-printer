/**
 * Printer endpoints: status, device discovery, and the async print job flow.
 *
 * The print flow is asynchronous because a print takes ~75 seconds (4s transfer
 * + 70s printing). Holding an HTTP request open that long makes clients time out
 * and leaves no way to show progress. Instead:
 *
 *   POST /api/print       → 202 + { id, state }        (returns immediately)
 *   GET  /api/print/:id   → current state and progress
 *   GET  /api/print/:id/events → Server-Sent Events, pushed as state changes
 *   GET  /api/print       → recent jobs
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { BadRequestException, Controller, Get, HttpCode, NotFoundException, Param, Post, Res, Sse, } from '@nestjs/common';
import { Observable, interval, map, takeWhile, merge } from 'rxjs';
import { PrinterService } from "./printer.service.js";
import { StagingService, MAX_IMAGE_KB } from "./staging.service.js";
import { addonBuilt } from "./bluetooth.js";
import { VERSION } from "../version.js";
let PrinterController = class PrinterController {
    printer;
    staging;
    constructor(printer, staging) {
        this.printer = printer;
        this.staging = staging;
    }
    // ------------------------------------------------------------------ probes
    health() {
        return {
            ok: true,
            version: VERSION,
            runtime: `node ${process.version}`,
            role: 'print-only',
            job: { width: 1200, height: 1800 },
            maxImageKb: MAX_IMAGE_KB,
            asyncPrint: true,
        };
    }
    device() {
        const built = addonBuilt();
        return {
            mac: {
                available: built,
                configured: Boolean(process.env.PRINTER_ADDRESS),
                candidates: this.printer.candidates(),
                message: built ? undefined : '原生蓝牙模块未编译，请运行：npm run build:native',
            },
            busy: this.printer.busy,
        };
    }
    status() {
        return this.printer.status();
    }
    // ------------------------------------------------------------------- jobs
    async startPrint(res) {
        const info = this.staging.info();
        if (!info) {
            throw new BadRequestException('尚未暂存成片，请先 POST /api/stage');
        }
        try {
            const job = this.printer.startPrint(info.path, info.sourceName);
            // 202 Accepted: the work has started but is not done.
            res.setHeader('Location', `/api/print/${job.id}`);
            return job;
        }
        catch (e) {
            // "Printer busy" is a conflict, not a client error.
            throw new BadRequestException(e instanceof Error ? e.message : String(e));
        }
    }
    listJobs() {
        return { jobs: this.printer.listJobs() };
    }
    getJob(id) {
        const job = this.printer.getJob(id);
        if (!job)
            throw new NotFoundException(`没有任务 ${id}（已完成的任务 30 分钟后清除）`);
        return job;
    }
    /**
     * Stream job progress as Server-Sent Events.
     *
     * Polls internally rather than pushing from the job runner, so the SSE layer
     * has no coupling to the print code and cannot miss or duplicate events.
     */
    jobEvents(id) {
        const initial = this.printer.getJob(id);
        if (!initial)
            throw new NotFoundException(`没有任务 ${id}`);
        const poll = interval(1000).pipe(map(() => this.printer.getJob(id)), takeWhile((job) => {
            // Stop when the job reaches a terminal state (the final event is
            // emitted by the `merge` below before this completes).
            return !!job && !isTerminal(job.state);
        }, true), map((job) => ({ data: job })));
        // Emit the current state immediately so a client that subscribes late is
        // not left waiting a full second for the first update.
        const first = new Observable((subscriber) => {
            subscriber.next({ data: initial });
            subscriber.complete();
        });
        return merge(first, poll);
    }
    // ------------------------------------------------------------------ staged
    staged() {
        const info = this.staging.info();
        if (!info)
            throw new NotFoundException('尚未生成成片');
        const { path: _path, ...rest } = info;
        return { ok: true, ...rest };
    }
    async stagedImage(res) {
        const bytes = await this.staging.read();
        if (!bytes)
            throw new NotFoundException('尚未生成成片');
        res.setHeader('content-type', 'image/jpeg');
        res.setHeader('content-length', String(bytes.length));
        res.end(bytes);
    }
};
__decorate([
    Get('health'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PrinterController.prototype, "health", null);
__decorate([
    Get('device'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PrinterController.prototype, "device", null);
__decorate([
    Get('printer/status'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PrinterController.prototype, "status", null);
__decorate([
    Post('print'),
    HttpCode(202),
    __param(0, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PrinterController.prototype, "startPrint", null);
__decorate([
    Get('print'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], PrinterController.prototype, "listJobs", null);
__decorate([
    Get('print/:id'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Object)
], PrinterController.prototype, "getJob", null);
__decorate([
    Sse('print/:id/events'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Observable)
], PrinterController.prototype, "jobEvents", null);
__decorate([
    Get('staged'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PrinterController.prototype, "staged", null);
__decorate([
    Get('staged/image'),
    __param(0, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PrinterController.prototype, "stagedImage", null);
PrinterController = __decorate([
    Controller('api'),
    __metadata("design:paramtypes", [PrinterService,
        StagingService])
], PrinterController);
export { PrinterController };
function isTerminal(state) {
    return state === 'finished' || state === 'failed' || state === 'cancelled';
}
//# sourceMappingURL=printer.controller.js.map