import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class SoundCloudProvider extends BaseProvider {
  constructor() {
    super({
      id: 'soundcloud',
      name: 'SoundCloud',
      priority: 70,
      domains: ['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'],
      pattern: /soundcloud\.com/i,
      capabilities: defineCapabilities({
        supportsAudio: true,
        supportsPlaylist: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new SoundCloudProvider(),
};

export default manifest;
