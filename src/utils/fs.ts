import { mkdir, rm } from 'node:fs/promises';

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function safeRemove(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
