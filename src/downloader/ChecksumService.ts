import { checksumFile } from '../utils/fs';

/**
 * ChecksumService produces a stable content hash used for cache reuse. It is
 * isolated so the hashing strategy can evolve without touching the engine.
 */
export class ChecksumService {
  async generate(filePath: string): Promise<string> {
    return await checksumFile(filePath);
  }
}
