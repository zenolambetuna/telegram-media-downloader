import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class InstagramProvider extends BaseProvider {
  constructor() {
    super({
      id: 'instagram',
      name: 'Instagram',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://instagram.com',
      priority: 80,
      domains: ['instagram.com', 'www.instagram.com'],
      pattern: /instagram\.com/i,
      engineCompatibility: '^1.0.0',
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
  manifestVersion: 1,
  create: () => new InstagramProvider(),
};

export default manifest;
