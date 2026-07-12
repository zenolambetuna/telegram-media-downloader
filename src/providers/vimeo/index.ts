import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class VimeoProvider extends BaseProvider {
  constructor() {
    super({
      id: 'vimeo',
      name: 'Vimeo',
      priority: 70,
      domains: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
      pattern: /vimeo\.com/i,
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
  create: () => new VimeoProvider(),
};

export default manifest;
