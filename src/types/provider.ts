import { SupportedPlatform } from './media';

/**
 * Capabilities a provider advertises. The engine and bot can read these to
 * decide what a provider is allowed to attempt. Defaults are conservative.
 */
export interface ProviderCapabilities {
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsPlaylist: boolean;
  supportsShorts: boolean;
  supportsReels: boolean;
  supportsStories: boolean;
  supportsLive: boolean;
  supportsPrivate: boolean;
  supportsAgeRestricted: boolean;
  supportsLogin: boolean;
}

/**
 * A provider is a plugin descriptor. It never performs downloads, yt-dlp,
 * ffmpeg, or Telegram work. It only declares identity, matching, and
 * capabilities. The Universal Download Engine does all heavy lifting.
 */
export interface MediaProvider {
  readonly id: SupportedPlatform;
  readonly name: string;
  readonly priority: number;
  readonly domains: string[];
  readonly capabilities: ProviderCapabilities;
  supports(url: string): boolean;
  healthCheck(): Promise<boolean>;
}

/**
 * Every provider folder exports a manifest as its default export. The
 * ProviderLoader discovers these automatically at startup.
 */
export interface ProviderManifest {
  create(): MediaProvider;
}
