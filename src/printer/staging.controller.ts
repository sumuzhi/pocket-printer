/**
 * Staging endpoints.
 *
 * The request body is the RAW JPEG, not multipart: there is exactly one field,
 * so a form envelope would carry no information and would mean handing bytes to
 * a multipart parser before they are validated.
 *
 * NestJS handles raw bodies with `rawBody: true` plus a `raw` body parser
 * (configured in `main.ts`); the bytes are read from `req.rawBody`, the
 * framework's documented approach, rather than by consuming the request stream
 * by hand.
 */

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request, Response } from 'express'

import { StagingService } from './staging.service.ts'
import { BadInputError } from '../common/errors.ts'

@Controller('api/staged')
export class StagingController {
  constructor(private readonly staging: StagingService) {}

  @Post()
  @HttpCode(200) // staging creates no addressable resource
  async stage(@Req() req: RawBodyRequest<Request>) {
    // The raw parser populates this whenever a body was sent. `undefined` means
    // the client sent nothing at all, which is a clear 400.
    const raw = req.rawBody
    if (!raw?.length) {
      throw new BadInputError('没有收到图片数据')
    }

    const name = decodeURIComponent(String(req.headers['x-source-name'] ?? ''))
    const info = await this.staging.stage(raw, name)
    return { ok: true, bytes: info.bytes, kb: Math.round((info.bytes / 1024) * 10) / 10 }
  }

  /** Return the staged image bytes, so a caller can confirm what will print. */
  @Get('image')
  async image(@Res() res: Response): Promise<void> {
    const bytes = await this.staging.read()
    if (!bytes) throw new NotFoundException('尚未生成成片')
    res.setHeader('content-type', 'image/jpeg')
    res.setHeader('content-length', String(bytes.length))
    res.end(bytes)
  }

  @Delete()
  async clear() {
    await this.staging.clear()
    return { ok: true }
  }

  @Get()
  info() {
    const info = this.staging.info()
    if (!info) throw new NotFoundException('尚未生成成片')
    const { path: _path, ...rest } = info
    return { ok: true, ...rest }
  }
}
