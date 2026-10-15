/**
 * A bare `GET /` so a human opening the port in a browser sees something useful
 * instead of a 404. This service has no UI by design.
 */
import { Controller, Get } from '@nestjs/common'

import { VERSION } from './version.ts'

@Controller()
export class RootController {
  @Get()
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
    }
  }
}
