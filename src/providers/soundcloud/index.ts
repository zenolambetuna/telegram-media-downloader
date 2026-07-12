import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class SoundCloudProvider extends BaseProvider {
  constructor() {
    super({
      id: 'soundcloud',
      name: 'SoundCloud',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://soundcloud.com',
      priority: 70,
      domains: ['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'],
      pattern: /soundcloud\.com/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsAudio: true,
        supportsPlaylist: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new SoundCloudProvider(),
};

export default manifest;
