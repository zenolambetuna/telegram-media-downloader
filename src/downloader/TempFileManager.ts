import { readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { ensureDirectory, safeRemove } from '../utils/fs';

/**
 * TempFileManager owns the lifecycle of the on-disk workspace. It creates a
 * unique workspace per job, cleans it after use, and can recover orphaned
 * workspaces left behind by a crash.
 */
export class TempFileManager {
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await ensureDirectory(config.TMP_DIR);
    try {
      await access(config.TMP_DIR, 0x2);
    } catch {
      logger.error({ tmpDir: config.TMP_DIR }, 'TMP_DIR is not writable');
      throw new Error(`Temp directory ${config.TMP_DIR} is not writable`);
    }
    this.initialized = true;
    logger.info({ tmpDir: config.TMP_DIR }, 'temp file manager initialized');
  }

  async createWorkspace(userId: number, jobId: string): Promise<string> {
    if (!this.initialized) await this.init();
    const workspace = path.join(config.TMP_DIR, String(userId), jobId);
    await ensureDirectory(workspace);
    return workspace;
  }

  async cleanWorkspace(workspace: string): Promise<void> {
    await safeRemove(workspace);
    logger.info({ workspace }, 'workspace cleaned');
  }

  async recoverOrphans(maxAgeMs: number): Promise<number> {
    let removed = 0;
    try {
      const roots = await readdir(config.TMP_DIR);
      const now = Date.now();
      for (const root of roots) {
        const rootPath = path.join(config.TMP_DIR, root);
        const info = await stat(rootPath).catch(() => null);
        if (!info) continue;
        if (now - info.mtimeMs > maxAgeMs) {
          await safeRemove(rootPath);
          removed += 1;
        }
      }
    } catch (error) {
      logger.warn({ error }, 'orphan recovery skipped');
    }
    if (removed > 0) {
      logger.info({ removed }, 'recovered orphan workspaces');
    }
    return removed;
  }
}
