/**
 * Application bootstrap, extracted so tests and production configure the app
 * identically.
 *
 * The body parsers, the raw-body option and the global exception filter are all
 * part of how this service behaves. Duplicating them in a test setup previously
 * meant tests exercised a differently-configured app: staging tests all failed
 * because the test app had no `raw` parser, so `req.rawBody` was undefined —
 * a configuration difference, not a code difference.
 */

import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'

import { AppModule } from './app.module.ts'
import { DomainExceptionFilter } from './common/domain-exception.filter.ts'

export const LOG_LEVELS = {
  normal: ['log', 'error', 'warn'],
  verbose: ['log', 'error', 'warn', 'debug', 'verbose'],
} as const

/**
 * Create the application with all production configuration applied.
 *
 * `verbose` only affects logging; everything else comes from ConfigService so
 * there is a single source of truth.
 */
export async function createApplication(verbose = false): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: verbose ? [...LOG_LEVELS.verbose] : [...LOG_LEVELS.normal],
    // Keep the unparsed body available on `req.rawBody`.
    //
    // POST /api/staged takes a JPEG as raw bytes, and the framework's own
    // mechanism for that is `rawBody: true` (see the Nest docs on raw body),
    // rather than reading the request stream by hand.
    rawBody: true,
  })

  configureApp(app)
  return app
}

/** Apply middleware, parsers and filters. Shared with tests. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService)
  const maxImageKb = config.getOrThrow<number>('maxImageKb')

  // Parse the staged image as raw bytes.
  //
  // The default parsers (json/urlencoded) do not match image content types, so
  // they leave the body unconsumed and `rawBody` is populated by the parser
  // registered here. `type: () => true` accepts any content type: callers send
  // the bytes with whatever `Content-Type` their HTTP client defaults to, and
  // the payload is validated as JPEG by the service, not by the content type.
  app.useBodyParser('raw', {
    type: () => true,
    // Express rejects anything larger with 413 before it is buffered; the
    // global filter turns that into the same message the service uses.
    limit: `${maxImageKb}kb`,
  })

  // CORS for a front-end running on another origin (a dev server, typically).
  //
  // Off by default: the service is normally reached directly or from the same
  // origin. It must be enabled for joint development, because EventSource (used
  // by the SSE endpoint) cannot bypass CORS with custom headers the way fetch
  // sometimes can — without these headers the progress stream simply fails.
  const corsOrigins = config.getOrThrow<string[]>('corsOrigins')
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      // `X-Source-Name` carries the file name for the staged image.
      allowedHeaders: ['Content-Type', 'X-Source-Name'],
      // SSE responses are text/event-stream; the browser reads them without
      // exposing them, but the header keeps the intent explicit.
      exposedHeaders: ['Location'],
    })
  }

  // One place decides how a domain error becomes an HTTP response.
  app.useGlobalFilters(new DomainExceptionFilter(maxImageKb))

  app.enableShutdownHooks()
}
