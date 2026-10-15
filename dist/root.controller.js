var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
/**
 * A bare `GET /` so a human opening the port in a browser sees something useful
 * instead of a 404. This service has no UI by design.
 */
import { Controller, Get } from '@nestjs/common';
import { VERSION } from "./version.js";
let RootController = class RootController {
    index() {
        return {
            service: '口袋打印机 · 送印服务',
            version: VERSION,
            note: '本服务只负责送印，不做任何图像处理。成片须为 1200×1800 的 JPEG。',
            endpoints: [
                'GET    /api/health',
                'GET    /api/device',
                'GET    /api/printer/status',
                'POST   /api/staged              暂存成片（原始 JPEG 字节，不耗纸）',
                'GET    /api/staged              查询暂存信息',
                'GET    /api/staged/image        取回暂存的图片',
                'DELETE /api/staged              清除暂存',
                'POST   /api/print               开始打印 → 202 + 任务对象（消耗相纸）',
                'GET    /api/print               最近的任务列表',
                'GET    /api/print/:id           查询单个任务',
                'GET    /api/print/:id/events    订阅任务进度（SSE）',
            ],
        };
    }
};
__decorate([
    Get(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], RootController.prototype, "index", null);
RootController = __decorate([
    Controller()
], RootController);
export { RootController };
//# sourceMappingURL=root.controller.js.map