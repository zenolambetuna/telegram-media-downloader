import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class PinterestProvider extends BaseProvider {
  constructor() {
    super({
      id: 'pinterest',
      name: 'Pinterest',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://pinterest.com',
      priority: 60,
      domains: ['pinterest.com', 'www.pinterest.com', 'pin.it'],
      pattern: /(?:pinterest\.|pin\.it)/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsVideo: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new PinterestProvider(),
};

export default manifest;
