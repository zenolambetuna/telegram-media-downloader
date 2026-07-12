import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class InstagramProvider extends BaseProvider {
  constructor() {
    super({
      id: 'instagram',
      name: 'Instagram',
      priority: 80,
      domains: ['instagram.com', 'www.instagram.com'],
      pattern: /instagram\.com/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsReels: true,
        supportsStories: true,
        supportsPrivate: true,
        supportsLogin: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new InstagramProvider(),
};

export default manifest;
