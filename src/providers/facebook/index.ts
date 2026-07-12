import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class FacebookProvider extends BaseProvider {
  constructor() {
    super({
      id: 'facebook',
      name: 'Facebook',
      priority: 80,
      domains: ['facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com'],
      pattern: /(?:facebook\.com|fb\.watch)/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsReels: true,
        supportsLive: true,
        supportsLogin: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new FacebookProvider(),
};

export default manifest;
