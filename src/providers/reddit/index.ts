import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class RedditProvider extends BaseProvider {
  constructor() {
    super({
      id: 'reddit',
      name: 'Reddit',
      priority: 70,
      domains: ['reddit.com', 'www.reddit.com', 'redd.it', 'v.redd.it'],
      pattern: /(?:reddit\.com|redd\.it)/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new RedditProvider(),
};

export default manifest;
