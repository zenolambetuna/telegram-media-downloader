import { BaseProvider } from '../shared/BaseProvider';

/**
 * TikTok provider with support for both regular and short URLs.
 * Handles: www.tiktok.com, tiktok.com, vt.tiktok.com, vm.tiktok.com
 */
export class TikTokProvider extends BaseProvider {
  readonly platform = 'tiktok' as const;
  protected readonly pattern = /(?:vt|vm)?\.?tiktok\.com/i;

  /**
   * Override supports() to explicitly handle all TikTok URL variants.
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