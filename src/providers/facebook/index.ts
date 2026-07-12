import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class FacebookProvider extends BaseProvider {
  constructor() {
    super({
      id: 'facebook',
      name: 'Facebook',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://facebook.com',
      priority: 80,
      domains: ['facebook.com', 'www.facebook.com', 'fb.watch', 'm.facebook.com'],
      pattern: /(?:facebook\.com|fb\.watch)/i,
      engineCompatibility: '^1.0.0',
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
  manifestVersion: 1,
  create: () => new FacebookProvider(),
};

export default manifest;
