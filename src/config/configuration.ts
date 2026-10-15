/**
 * Application configuration, read from the environment in one place.
 *
 * Follows the NestJS `ConfigModule` convention: a factory returning a typed
 * object, rather than `process.env` lookups scattered through services. That
 * makes the full set of knobs visible at a glance and gives each one a default.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AppConfig {
  port: number
  host: string
  /** Explicit printer address; when unset, the printer is auto-discovered. */
  printerAddress?: string
  /** Version, surfaced by /api/health. */
  version: string
  /** Bytes accepted for one finished sheet (the plugin's 2048 KB default). */
  maxImageKb: number
}

export const MAX_IMAGE_KB_DEFAULT = 2048

/**
 * Read the version from package.json.
 *
 * `process.env.npm_package_version` would be simpler but only exists when the
 * process was started through an npm script — running `node dist/main.js`
 * directly reported 0.0.0. Reading the manifest works either way.
 *
 * The path is resolved relative to this file, which sits one level below the
 * project root in both `src/config/` and `dist/config/`.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return process.env.npm_package_version ?? '0.0.0'
  }
}

export function loadConfig(): AppConfig {
  const num = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  return {
    port: num(process.env.PORT, 8000),
    host: process.env.HOST ?? '127.0.0.1',
    // Empty string means "not set"; auto-discovery is the default.
    printerAddress: process.env.PRINTER_ADDRESS || undefined,
    version: readVersion(),
    maxImageKb: num(process.env.MAX_IMAGE_KB, MAX_IMAGE_KB_DEFAULT),
  }
}
