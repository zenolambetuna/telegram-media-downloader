import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class ThreadsProvider extends BaseProvider {
  constructor() {
    super({
      id: 'threads',
      name: 'Threads',
      priority: 70,
      domains: ['threads.net', 'www.threads.net'],
      pattern: /threads\.net/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new ThreadsProvider(),
};

export default manifest;
