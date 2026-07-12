import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class RedditProvider extends BaseProvider {
  constructor() {
    super({
      id: 'reddit',
      name: 'Reddit',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://reddit.com',
      priority: 70,
      domains: ['reddit.com', 'www.reddit.com', 'redd.it', 'v.redd.it'],
      pattern: /(?:reddit\.com|redd\.it)/i,
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
  create: () => new RedditProvider(),
};

export default manifest;
