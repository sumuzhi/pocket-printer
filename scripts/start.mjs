#!/usr/bin/env node
/**
 * Production entry: check the build exists, then start the server.
 *
 * Exists because `node dist/main.js` on an unbuilt tree fails with a bare
 * module-not-found stack trace that says nothing about the fix. NestJS needs a
 * build step, so forgetting it is the most likely first mistake — the error
 * should name the command that fixes it.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const MAIN = resolve(ROOT, 'dist/main.js')

if (!existsSync(MAIN)) {
  process.stderr.write(
    '\n\x1b[31m未找到构建产物\x1b[0m dist/main.js\n\n' +
      'NestJS 依赖装饰器元数据，需要先构建：\n\n' +
      '    npm run build     # 构建一次\n' +
      '    npm start         # 然后启动\n\n' +
      '开发时用以下命令，它会监听改动并自动重启：\n\n' +
      '    npm run dev\n\n',
  )
  process.exit(1)
}

const child = spawn(process.execPath, [MAIN, ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
