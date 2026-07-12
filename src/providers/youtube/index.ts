import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

/**
 * YouTube provider plugin.
 *
 * This is intentionally a thin, declarative plugin. All download mechanics
 * (yt-dlp extraction, dynamic format discovery, normalization, audio/video
 * merge, clean filenames, progress callbacks, retries, and integrity checks)
 * are owned by the Universal Download Engine and shared by every provider.
 * A provider MUST NOT talk to yt-dlp, ffmpeg, or Telegram directly. It only
 * declares identity, matching, and capabilities. The engine does the rest and
 * returns normalized media; the Storage Engine uploads to Telegram.
 *
 * Detects: youtube.com, www.youtube.com, m.youtube.com, music.youtube.com,
 * and youtu.be short links (including Shorts and live replay URLs, which are
 * all youtube.com paths).
 */
class YouTubeProvider extends BaseProvider {
  constructor() {
    super({
      id: 'youtube',
      name: 'YouTube',
      version: '1.0.0',
      author: 'core',
      homepage: 'https://youtube.com',
      priority: 100,
      domains: [
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be',
      ],
      // Matches every YouTube surface: main, mobile, music subdomains all
      // contain "youtube.com"; youtu.be covers short links. Shorts and live
      // replay are normal youtube.com paths and need no special casing.
      pattern: /(?:^|\.)(?:youtube\.com|youtu\.be)/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({
        supportsVideo: true,
        supportsAudio: true,
        supportsPlaylist: true,
        supportsShorts: true,
        supportsLive: true,
        supportsAgeRestricted: true,
        supportsPrivate: true,
        supportsLogin: true,
      }),
      configSchema: [
        {
          key: 'cookiesFile',
          label: 'Path to a Netscape cookies file for age-restricted or private videos',
          type: 'string',
          required: false,
          secret: true,
        },
        {
          key: 'preferMp4',
          label: 'Prefer mp4 container when merging video and audio',
          type: 'boolean',
          required: false,
          default: true,
        },
      ],
    });
  }

  /**
   * Stricter matcher than the base pattern. Validates the URL and confirms the
   * host is a real YouTube host, so lookalikes like "notyoutube.com" or
   * "youtube.com.evil.tld" do not match.
   */
  override supports(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'youtu.be' ||
      host === 'youtube.com' ||
      host.endsWith('.youtube.com')
    );
  }
}

const manifest: ProviderManifest = {
  manifestVersion: 1,
  create: () => new YouTubeProvider(),
};

export default manifest;
