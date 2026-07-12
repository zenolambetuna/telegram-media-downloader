import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class YouTubeProvider extends BaseProvider {
  constructor() {
    super({
      id: 'youtube',
      name: 'YouTube',
      priority: 100,
      domains: ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'],
      pattern: /(?:youtube\.com|youtu\.be)/i,
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsPlaylist: true,
        supportsShorts: true,
        supportsLive: true,
        supportsAgeRestricted: true,
        supportsLogin: true,
      }),
    });
  }
}

const manifest: ProviderManifest = {
  create: () => new YouTubeProvider(),
};

export default manifest;
