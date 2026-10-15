/**
 * Maps domain errors to HTTP responses, in one place.
 *
 * Services throw `BadInputError` / `ConflictError` / etc. without knowing about
 * HTTP; this filter decides the status code and the response shape. Centralising
 * it means the error contract can be reviewed as a whole instead of being
 * scattered across controllers as ad-hoc `try`/`catch` + `res.status(...)`.
 *
 * Express's own `PayloadTooLargeError` (thrown by the raw body parser when a
 * request exceeds the limit) is handled here too, so an oversized upload gets
 * the same message whether the limit is enforced before or during the handler.
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common'
import type { Response } from 'express'
import { HttpStatus } from '@nestjs/common'

import { DomainError } from './errors.ts'

interface ErrorBody {
  statusCode: number
  message: string
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(DomainExceptionFilter.name)

  constructor(private readonly maxImageKb: number) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()

    const { status, message } = this.describe(exception)

    // A 5xx means a bug or an outage; a 4xx is the caller's to fix. Log
    // accordingly so the console is not noisy with expected client mistakes.
    if (status >= 500) {
      this.log.error(`${status} ${message}`, exception instanceof Error ? exception.stack : undefined)
    } else if (status !== 404) {
      this.log.warn(`${status} ${message}`)
    }

    res.status(status).json({ statusCode: status, message } satisfies ErrorBody)
  }

  private describe(exception: unknown): { status: number; message: string } {
    if (exception instanceof DomainError) {
      return { status: exception.status, message: exception.message }
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      const response = exception.getResponse()
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message)
      return { status, message: Array.isArray(message) ? message.join('；') : message }
    }

    // express.raw rejects oversized bodies with this shape.
    if (isExpressPayloadTooLarge(exception)) {
      const limit = `成片超过上限 ${this.maxImageKb}KB，请降低导出质量后重试`
      return { status: HttpStatus.PAYLOAD_TOO_LARGE, message: limit }
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: exception instanceof Error ? exception.message : String(exception),
    }
  }
}

function isExpressPayloadTooLarge(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const candidate = e as { type?: string; status?: number; statusCode?: number }
  return (
    candidate.type === 'entity.too.large' ||
    (candidate.status ?? candidate.statusCode) === HttpStatus.PAYLOAD_TOO_LARGE
  )
}
