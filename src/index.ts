#!/usr/bin/env node
/**
 * Entry point.
 *
 *   node src/index.ts                    # port 8000
 *   node src/index.ts --port 9000 --verbose
 *
 * Node runs TypeScript directly (type stripping), so there is no build step.
 */
import { createApp } from './http.ts'
import { addonBuilt, listCandidates } from './bluetooth.ts'

function parseArgs(argv: string[]) {
  const args = { port: 8000, host: '127.0.0.1', verbose: false, address: undefined as string | undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--verbose' || a === '-v') args.verbose = true
    else if (a === '--address') args.address = argv[++i]
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node src/index.ts [选项]\n\n' +
          '  --port <n>       监听端口（默认 8000）\n' +
          '  --host <addr>    监听地址（默认 127.0.0.1）\n' +
          '  --address <mac>  指定打印机地址，跳过自动发现\n' +
          '  --verbose        打印蓝牙通信细节\n' +
          '  --help           显示本帮助\n\n' +
          '打印机地址默认为自动发现：扫描已配对设备并逐个尝试连接。\n',
      )
      process.exit(0)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const server = createApp({
  port: args.port,
  verbose: args.verbose,
  address: args.address,
})

server.listen(args.port, args.host, () => {
  const built = addonBuilt()
  process.stdout.write(`口袋打印机 · 送印服务（Node ${process.version}）\n`)
  process.stdout.write(`  地址: http://${args.host}:${args.port}\n`)
  if (!built) {
    process.stdout.write(`  蓝牙: ⚠ 原生模块未编译 —— 请运行 npm run build:native\n`)
  } else if (args.address) {
    process.stdout.write(`  蓝牙: 使用指定地址 ${args.address}\n`)
  } else {
    let found: Array<{ address: string; name: string }> = []
    try {
      found = listCandidates().slice(0, 3).map((c) => ({ address: c.address, name: c.name }))
    } catch {
      /* enumeration is best-effort */
    }
    process.stdout.write(`  蓝牙: 自动发现（${found.length} 台候选设备）\n`)
    for (const c of found) process.stdout.write(`        ${c.address}  ${c.name}\n`)
  }
  process.stdout.write(`  职责: 接收成片字节并送印，不做任何图像处理\n`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
