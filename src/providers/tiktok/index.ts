import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class TikTokProvider extends BaseProvider {
  readonly platform = 'tiktok' as const;
  protected readonly pattern = /(?:vt|vm)?\.?tiktok\.com/i;

  constructor() {
    super({
      id: 'tiktok',
      name: 'TikTok',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://tiktok.com',
      priority: 80,
      domains: ['tiktok.com', 'www.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'],
      pattern: /(?:vt|vm)?\.?tiktok\.com/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsShorts: true,
      }),
    });
  }

  /**
   * Override supports() to explicitly handle all TikTok URL variants including
   * short links (vt.tiktok.com, vm.tiktok.com).
   */
  supports(url: string): boolean {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return (
        host.includes('tiktok.com') ||
        host === 'vt.tiktok.com' ||
        host === 'vm.tiktok.com'
      );
    } catch {
      return false;
    }
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new TikTokProvider(),
};

export default manifest;