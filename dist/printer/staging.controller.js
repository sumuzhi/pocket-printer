/**
 * Staging endpoints.
 *
 * The request body is the RAW JPEG, not multipart. Two reasons:
 *
 *  - multipart parsing means handing the bytes to a parser before we validate
 *    them, so a malformed upload is partly processed before being rejected;
 *  - there is exactly one field, so the envelope carries no information.
 *
 * The body arrives as a stream, so it is read with a size cap rather than
 * buffered blindly — an oversized upload must be refused *before* it is held in
 * memory, not after.
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
import { Controller, Delete, HttpCode, HttpException, Post, Req, } from '@nestjs/common';
import { StagingService, StagingError, MAX_IMAGE_BYTES, MAX_IMAGE_KB } from "./staging.service.js";
let StagingController = class StagingController {
    staging;
    constructor(staging) {
        this.staging = staging;
    }
    async stage(req) {
        // The stream is read here because the body parsers are disabled globally
        // (see main.ts): this endpoint takes raw bytes, and a parser would drain
        // the stream before the handler could see it.
        const raw = await readCapped(req, MAX_IMAGE_BYTES + 1);
        const name = decodeURIComponent(String(req.headers['x-source-name'] ?? ''));
        try {
            const info = await this.staging.stage(raw, name);
            return { ok: true, bytes: info.bytes, kb: Math.round((info.bytes / 1024) * 10) / 10 };
        }
        catch (e) {
            if (e instanceof StagingError)
                throw new HttpException(e.message, e.status);
            throw e;
        }
    }
    async clear() {
        await this.staging.clear();
        return { ok: true };
    }
};
__decorate([
    Post(),
    HttpCode(200) // staging creates no resource; 200 matches the pre-Nest API
    ,
    __param(0, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], StagingController.prototype, "stage", null);
__decorate([
    Delete(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], StagingController.prototype, "clear", null);
StagingController = __decorate([
    Controller('api/staged'),
    __metadata("design:paramtypes", [StagingService])
], StagingController);
export { StagingController };
/**
 * Read the request body, refusing early once `limit` bytes have arrived.
 *
 * `raw-body` would do this, but it is one dependency for one function and the
 * behaviour here is worth stating explicitly.
 */
function readCapped(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let overflowed = false;
        req.on('data', (chunk) => {
            if (overflowed)
                return;
            total += chunk.length;
            if (total > limit) {
                // Stop buffering, but do NOT destroy the socket: that would drop the
                // connection and the caller would see "socket hang up" instead of the
                // reason. Pause instead, so the response can still be written — the
                // client learns *why* it was refused.
                overflowed = true;
                chunks.length = 0;
                req.pause();
                reject(new HttpException(`成片超过上限 ${MAX_IMAGE_KB}KB，请降低导出质量后重试`, 413));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!overflowed)
                resolve(Buffer.concat(chunks));
        });
        req.on('error', (e) => {
            if (!overflowed)
                reject(e);
        });
    });
}
//# sourceMappingURL=staging.controller.js.map