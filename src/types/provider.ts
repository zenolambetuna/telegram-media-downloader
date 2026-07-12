import { SupportedPlatform } from './media';

/**
 * A provider is now a thin descriptor. It only declares its platform identity
 * and whether it can handle a given URL. It never calls yt-dlp, ffmpeg, or
 * Telegram. All heavy lifting is owned by the Universal Download Engine.
 */
export interface MediaProvider {
  readonly platform: SupportedPlatform;
  supports(url: string): boolean;
  healthCheck(): Promise<boolean>;
}
