import { MediaProvider, ProviderCapabilities } from '../../types/provider';
import { SupportedPlatform } from '../../types/media';

export interface BaseProviderConfig {
  id: SupportedPlatform;
  name: string;
  priority: number;
  domains: string[];
  pattern: RegExp;
  capabilities: ProviderCapabilities;
}

/**
 * BaseProvider is the single base class every provider inherits. A concrete
 * provider passes a config describing its identity, domains, URL pattern, and
 * capabilities. It performs NO downloading, NO yt-dlp, NO ffmpeg, and NO
 * Telegram work.
 */
export abstract class BaseProvider implements MediaProvider {
  readonly id: SupportedPlatform;
  readonly name: string;
  readonly priority: number;
  readonly domains: string[];
  readonly capabilities: ProviderCapabilities;
  private readonly pattern: RegExp;

  protected constructor(config: BaseProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.priority = config.priority;
    this.domains = config.domains;
    this.capabilities = config.capabilities;
    this.pattern = config.pattern;
  }

  supports(url: string): boolean {
    return this.pattern.test(url);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
