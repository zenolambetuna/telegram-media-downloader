import { MediaProvider } from '../../types/provider';
import { SupportedPlatform } from '../../types/media';

/**
 * BaseProvider is a thin descriptor. A provider only declares its platform and
 * a URL matcher. It performs NO downloading, NO yt-dlp, NO ffmpeg, and NO
 * Telegram work. The Universal Download Engine does all of that. Adding a new
 * provider is now just: extend this, set platform, set the URL pattern.
 */
export abstract class BaseProvider implements MediaProvider {
  abstract readonly platform: SupportedPlatform;
  protected abstract readonly pattern: RegExp;

  supports(url: string): boolean {
    return this.pattern.test(url);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
