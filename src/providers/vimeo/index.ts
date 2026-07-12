import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class VimeoProvider extends BaseProvider {
  constructor() {
    super({
      id: 'vimeo',
      name: 'Vimeo',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://vimeo.com',
      priority: 70,
      domains: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
      pattern: /vimeo\.com/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsPrivate: true,
        supportsLogin: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new VimeoProvider(),
};

export default manifest;
