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

import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  Sse,
  MessageEvent,
} from '@nestjs/common'
import { Observable, interval, map, takeWhile, merge } from 'rxjs'
import type { Response } from 'express'

import { PrinterService } from './printer.service.ts'
import type { PrintJob, PrinterStatus } from './printer.service.ts'
import { StagingService, MAX_IMAGE_KB } from './staging.service.ts'
import { addonBuilt } from './bluetooth.ts'
import { VERSION } from '../version.ts'

@Controller('api')
export class PrinterController {
  constructor(
    private readonly printer: PrinterService,
    private readonly staging: StagingService,
  ) {}

  // ------------------------------------------------------------------ probes

  @Get('health')
  health() {
    return {
      ok: true,
      version: VERSION,
      runtime: `node ${process.version}`,
      role: 'print-only',
      job: { width: 1200, height: 1800 },
      maxImageKb: MAX_IMAGE_KB,
      asyncPrint: true,
    }
  }

  @Get('device')
  device() {
    const built = addonBuilt()
    return {
      mac: {
        available: built,
        configured: Boolean(process.env.PRINTER_ADDRESS),
        candidates: this.printer.candidates(),
        message: built ? undefined : '原生蓝牙模块未编译，请运行：npm run build:native',
      },
      busy: this.printer.busy,
    }
  }

  @Get('printer/status')
  status(): Promise<PrinterStatus> {
    return this.printer.status()
  }

  // ------------------------------------------------------------------- jobs

  @Post('print')
  @HttpCode(202)
  async startPrint(@Res({ passthrough: true }) res: Response): Promise<PrintJob> {
    const info = this.staging.info()
    if (!info) {
      throw new BadRequestException('尚未暂存成片，请先 POST /api/stage')
    }
    try {
      const job = this.printer.startPrint(info.path, info.sourceName)
      // 202 Accepted: the work has started but is not done.
      res.setHeader('Location', `/api/print/${job.id}`)
      return job
    } catch (e) {
      // "Printer busy" is a conflict, not a client error.
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  @Get('print')
  listJobs(): { jobs: PrintJob[] } {
    return { jobs: this.printer.listJobs() }
  }

  @Get('print/:id')
  getJob(@Param('id') id: string): PrintJob {
    const job = this.printer.getJob(id)
    if (!job) throw new NotFoundException(`没有任务 ${id}（已完成的任务 30 分钟后清除）`)
    return job
  }

  /**
   * Stream job progress as Server-Sent Events.
   *
   * Polls internally rather than pushing from the job runner, so the SSE layer
   * has no coupling to the print code and cannot miss or duplicate events.
   */
  @Sse('print/:id/events')
  jobEvents(@Param('id') id: string): Observable<MessageEvent> {
    const initial = this.printer.getJob(id)
    if (!initial) throw new NotFoundException(`没有任务 ${id}`)

    const poll = interval(1000).pipe(
      map(() => this.printer.getJob(id)),
      takeWhile((job) => {
        // Stop when the job reaches a terminal state (the final event is
        // emitted by the `merge` below before this completes).
        return !!job && !isTerminal(job.state)
      }, true),
      map((job) => ({ data: job } as MessageEvent)),
    )

    // Emit the current state immediately so a client that subscribes late is
    // not left waiting a full second for the first update.
    const first: Observable<MessageEvent> = new Observable((subscriber) => {
      subscriber.next({ data: initial } as MessageEvent)
      subscriber.complete()
    })

    return merge(first, poll)
  }

  // ------------------------------------------------------------------ staged

  @Get('staged')
  staged() {
    const info = this.staging.info()
    if (!info) throw new NotFoundException('尚未生成成片')
    const { path: _path, ...rest } = info
    return { ok: true, ...rest }
  }

  @Get('staged/image')
  async stagedImage(@Res() res: Response): Promise<void> {
    const bytes = await this.staging.read()
    if (!bytes) throw new NotFoundException('尚未生成成片')
    res.setHeader('content-type', 'image/jpeg')
    res.setHeader('content-length', String(bytes.length))
    res.end(bytes)
  }
}

function isTerminal(state: PrintJob['state']): boolean {
  return state === 'finished' || state === 'failed' || state === 'cancelled'
}
