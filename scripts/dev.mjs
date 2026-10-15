#!/usr/bin/env node
/**
 * Development runner: compile-on-change plus automatic restart.
 *
 * Why not `node --watch src/main.ts`? Because NestJS resolves constructor
 * injection from `design:paramtypes` metadata, which only `tsc` emits —
 * Node's type stripping and esbuild both drop it, and the app would fail to
 * start with "Nest can't resolve dependencies". So compilation has to be real
 * `tsc`, and running requires the compiled output.
 *
 * `tsc --watch` handles incremental compilation; this script watches `dist/`
 * and restarts the child process when a rebuild lands. Doing both in one process
 * avoids a dependency like `concurrently` and makes the restart deterministic:
 * the server is only restarted after tsc reports a successful emit (`Found 0
 * errors`), so a broken intermediate state never gets loaded.
 *
 * Usage: node scripts/dev.mjs [--port 8000] [--verbose]
 */

import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST_MAIN = resolve(ROOT, 'dist/main.js')
const TSC = resolve(ROOT, 'node_modules/.bin/tsc')

const passthrough = process.argv.slice(2)

let child = null
let compiling = true
let restartQueued = false
let shuttingDown = false

function log(msg) {
  process.stdout.write(`\x1b[36m[dev]\x1b[0m ${msg}\n`)
}

function startServer() {
  if (shuttingDown) return
  if (!existsSync(DIST_MAIN)) {
    log('等待首次编译完成…')
    return
  }
  if (child) {
    // A restart is already scheduled; do not stack processes.
    restartQueued = true
    return
  }
  log(`启动服务 ${passthrough.join(' ') || '(默认参数)'}`)
  child = spawn(process.execPath, [DIST_MAIN, ...passthrough], {
    stdio: 'inherit',
    env: process.env,
  })
  child.on('exit', (code, signal) => {
    child = null
    if (shuttingDown) return
    if (code !== 0 && code !== null) {
      // The server exited on its own (e.g. port in use). Say so rather than
      // silently restarting forever.
      log(`服务退出（code ${code}${signal ? `, ${signal}` : ''}）—— 修改代码后会自动重启`)
    }
    if (restartQueued) {
      restartQueued = false
      startServer()
    }
  })
}

function restartServer() {
  if (!child) {
    startServer()
    return
  }
  restartQueued = true
  child.kill('SIGTERM')
}

// ---------------------------------------------------------------- tsc watch

log('启动 TypeScript 监听编译…')
const tsc = spawn(TSC, ['-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let buffer = ''
const onTscOutput = (chunk) => {
  const text = chunk.toString()
  buffer += text
  // tsc --watch prints a status line after each build; a successful emit is
  // reported as "Found 0 errors. Watching for file changes."
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.includes('Found 0 errors')) {
      if (compiling) {
        compiling = false
        log('首次编译完成')
        startServer()
      } else {
        log('编译完成，重启服务')
        restartServer()
      }
    } else if (/error TS\d+/.test(trimmed)) {
      // Keep the previous process running on a compile error: a half-written
      // file should not take the server down.
      process.stderr.write(`\x1b[31m[tsc]\x1b[0m ${trimmed}\n`)
    }
  }
}
tsc.stdout.on('data', onTscOutput)
tsc.stderr.on('data', onTscOutput)

// ----------------------------------------------------------- dist fallback

// tsc's own status line is the primary signal, but a filesystem watch makes the
// restart robust if the output format ever changes.
try {
  watch(resolve(ROOT, 'dist'), { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith('.js')) return
    if (compiling) return
    restartServer()
  })
} catch {
  // Watching is best-effort; tsc output alone is sufficient.
}

// ---------------------------------------------------------------- shutdown

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`收到 ${signal}，正在退出…`)
  try {
    tsc.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  if (child) {
    child.once('exit', () => process.exit(0))
    child.kill('SIGTERM')
    setTimeout(() => process.exit(0), 2000).unref()
  } else {
    process.exit(0)
  }
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
