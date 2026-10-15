#!/usr/bin/env node
/**
 * Entry point.
 *
 *   node dist/main.js                          # port 8000
 *   node dist/main.js --port 9000 --verbose
 *
 * Requires a build step (`npm run build`): NestJS uses decorators, and Node's
 * type stripping cannot emit the decorator metadata they rely on.
 */
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'

import { AppModule } from './app.module.ts'
import { addonBuilt, listCandidates } from './printer/bluetooth.ts'

interface Args {
  port: number
  host: string
  address?: string
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 8000, host: '127.0.0.1', verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--address') args.address = argv[++i]
    else if (a === '--verbose' || a === '-v') args.verbose = true
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node dist/main.js [选项]\n\n' +
          '  --port <n>       监听端口（默认 8000）\n' +
          '  --host <addr>    监听地址（默认 127.0.0.1）\n' +
          '  --address <mac>  指定打印机地址，跳过自动发现\n' +
          '  --verbose        打印更多日志\n' +
          '  --help           显示本帮助\n\n' +
          '打印机地址默认为自动发现：扫描已配对设备并逐个尝试连接。\n' +
          '也可用环境变量 PRINTER_ADDRESS 指定。\n',
      )
      process.exit(0)
    }
  }
  return args
}

async function bootstrap(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // The address must be set before any service reads it.
  if (args.address) process.env.PRINTER_ADDRESS = args.address

  const app = await NestFactory.create(AppModule, {
    logger: args.verbose
      ? ['log', 'error', 'warn', 'debug', 'verbose']
      : ['log', 'error', 'warn'],
    // Disable the default body parsers (json + urlencoded).
    //
    // They consume the request stream, and the only endpoint that takes a body
    // — POST /api/staged — reads the RAW jpeg bytes off that stream itself. With
    // the parsers active the stream is already drained, so the handler waited
    // forever and the request hung.
    //
    // Nothing here needs parsed bodies, so turning them off is both the fix and
    // the simplest configuration.
    bodyParser: false,
  })
  app.enableShutdownHooks()
  await app.listen(args.port, args.host)

  const built = addonBuilt()
  const out = process.stdout
  out.write(`口袋打印机 · 送印服务（Node ${process.version}，NestJS）\n`)
  out.write(`  地址: http://${args.host}:${args.port}\n`)
  if (!built) {
    out.write(`  蓝牙: ⚠ 原生模块未编译 —— 请运行 npm run build:native\n`)
  } else if (args.address) {
    out.write(`  蓝牙: 使用指定地址 ${args.address}\n`)
  } else {
    let found: Array<{ address: string; name: string }> = []
    try {
      found = listCandidates().slice(0, 3).map((c) => ({ address: c.address, name: c.name }))
    } catch {
      /* enumeration is best-effort */
    }
    out.write(`  蓝牙: 自动发现（${found.length} 台候选设备）\n`)
    for (const c of found) out.write(`        ${c.address}  ${c.name}\n`)
  }
  out.write(`  职责: 接收成片字节并送印，不做任何图像处理\n`)
  out.write(`  打印: 异步任务模型 —— POST /api/print 立即返回，用 GET /api/print/:id 查询\n`)
}

bootstrap().catch((e: unknown) => {
  new Logger('bootstrap').error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
