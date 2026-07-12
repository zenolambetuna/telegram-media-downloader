import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function safeRemove(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export async function checksumFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  return await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
