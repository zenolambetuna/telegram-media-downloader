import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class ThreadsProvider extends BaseProvider {
  constructor() {
    super({
      id: 'threads',
      name: 'Threads',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://threads.net',
      priority: 70,
      domains: ['threads.net', 'www.threads.net'],
      pattern: /threads\.net/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new ThreadsProvider(),
};

export default manifest;
