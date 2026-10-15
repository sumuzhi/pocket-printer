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
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  Sse,
} from '@nestjs/common'
import type { MessageEvent } from '@nestjs/common'
import { Observable, filter, map, merge, of, takeWhile } from 'rxjs'
import type { Response } from 'express'

import { PrinterService } from './printer.service.ts'
import type { PrintJob, PrinterStatus } from './printer.service.ts'
import { StagingService } from './staging.service.ts'
import { addonBuilt } from './bluetooth.ts'
import { BadInputError } from '../common/errors.ts'
import { ConfigService } from '@nestjs/config'

@Controller('api')
export class PrinterController {
  constructor(
    private readonly printer: PrinterService,
    private readonly staging: StagingService,
    private readonly config: ConfigService,
  ) {}

  // ------------------------------------------------------------------ probes

  @Get('health')
  health() {
    return {
      ok: true,
      version: this.config.get<string>('version'),
      runtime: `node ${process.version}`,
      role: 'print-only',
      job: { width: 1200, height: 1800 },
      maxImageKb: this.config.get<number>('maxImageKb'),
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
  startPrint(@Res({ passthrough: true }) res: Response): PrintJob {
    const info = this.staging.info()
    if (!info) {
      throw new BadInputError('尚未暂存成片，请先 POST /api/staged')
    }
    // The service throws ConflictError when busy; DomainExceptionFilter maps it
    // to 409. Controllers do not translate errors — that lives in one place.
    const job = this.printer.startPrint(info.path, info.sourceName)
    // 202 Accepted: the work has started but is not done.
    res.setHeader('Location', `/api/print/${job.id}`)
    return job
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
   * Event-driven: `PrinterService` publishes each state change and this filters
   * that stream to one job. The previous version polled the job map once per
   * second per subscriber, which reported changes up to a second late and kept
   * ticking for as long as anyone was listening.
   *
   * The first emission is the job's current state, so a client that subscribes
   * mid-print sees where things stand instead of waiting for the next change.
   */
  @Sse('print/:id/events')
  jobEvents(@Param('id') id: string): Observable<MessageEvent> {
    const initial = this.printer.getJob(id)
    if (!initial) throw new NotFoundException(`没有任务 ${id}`)

    return merge(
      // Where the job is right now.
      of(initial),
      // Every subsequent change, until it reaches a terminal state.
      this.printer.watch().pipe(filter((job) => job.id === id)),
    ).pipe(
      takeWhile((job) => !isTerminal(job.state), true),
      map((job) => ({ data: job }) as MessageEvent),
    )
  }
}

function isTerminal(state: PrintJob['state']): boolean {
  return state === 'finished' || state === 'failed' || state === 'cancelled'
}
