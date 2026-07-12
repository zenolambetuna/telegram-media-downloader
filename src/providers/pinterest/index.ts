import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class PinterestProvider extends BaseProvider {
  constructor() {
    super({
      id: 'pinterest',
      name: 'Pinterest',
      priority: 60,
      domains: ['pinterest.com', 'www.pinterest.com', 'pin.it'],
      pattern: /(?:pinterest\.|pin\.it)/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new PinterestProvider(),
};

export default manifest;
