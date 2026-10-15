/**
 * Staging: holding the finished sheet until the caller decides to print it.
 *
 * Staging and printing are separate on purpose. Staging is free and repeatable;
 * printing consumes a sheet of paper. Keeping them apart means a caller can
 * stage, inspect, re-stage, and only then commit — which is the whole point of
 * the confirmation flow.
 *
 * Bytes are written verbatim. No re-encoding: silent downscaling is how a print
 * ends up different from what the caller approved.
 */

import { Injectable, Logger } from '@nestjs/common'
import { readFile, stat, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Mirrors the plugin's `imageSizeQualityCompress` default. */
export const MAX_IMAGE_KB = 2048
export const MAX_IMAGE_BYTES = MAX_IMAGE_KB * 1024

const STAGE_FILE = join(tmpdir(), 'pocket_print_staged.jpg')

export interface StagedImage {
  bytes: number
  stagedAt: number
  sourceName: string
  path: string
}

export class StagingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

@Injectable()
export class StagingService {
  private readonly log = new Logger(StagingService.name)
  private current: StagedImage | null = null

  /**
   * Accept the caller's bytes.
   *
   * Rejects loudly rather than repairing: a PNG or an oversized file would
   * otherwise print as a corrupt or degraded job, and the caller would not know
   * why the result differs from their preview.
   */
  async stage(raw: Buffer, sourceName: string): Promise<StagedImage> {
    if (!raw.length) {
      throw new StagingError('没有收到图片数据', 400)
    }
    if (raw.length > MAX_IMAGE_BYTES) {
      throw new StagingError(
        `成片 ${Math.round(raw.length / 1024)}KB 超过上限 ${MAX_IMAGE_KB}KB。请降低导出质量后重试。`,
        413,
      )
    }
    if (!(raw[0] === 0xff && raw[1] === 0xd8)) {
      throw new StagingError('成片必须是 JPEG（未检测到 JPEG 文件头）', 400)
    }

    await writeFile(STAGE_FILE, raw)
    this.current = {
      bytes: raw.length,
      stagedAt: Date.now(),
      sourceName,
      path: STAGE_FILE,
    }
    this.log.log(`已暂存 ${sourceName || '(未命名)'}：${raw.length} 字节`)
    return this.current
  }

  info(): StagedImage | null {
    if (!this.current || !existsSync(this.current.path)) return null
    return this.current
  }

  /** The staged file's path, or null. Used to hand bytes to the printer. */
  path(): string | null {
    return this.info()?.path ?? null
  }

  async read(): Promise<Buffer | null> {
    const info = this.info()
    if (!info) return null
    return readFile(info.path)
  }

  async clear(): Promise<void> {
    this.current = null
    try {
      await unlink(STAGE_FILE)
    } catch {
      // Already gone; clearing an empty slot is not an error.
    }
  }

  /** Size on disk, for a consistency check after staging. */
  async sizeOnDisk(): Promise<number> {
    try {
      return (await stat(STAGE_FILE)).size
    } catch {
      return -1
    }
  }
}
