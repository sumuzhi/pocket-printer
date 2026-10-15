/**
 * Service version, read from package.json so the two cannot drift apart.
 *
 * They did once: the health endpoint reported 3.0.0 while the manifest said
 * 1.0.0, because the value was hard-coded in two places.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
