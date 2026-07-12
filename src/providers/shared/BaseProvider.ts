import { MediaProvider, ProviderCapabilities, ProviderConfigSchema, ProviderMetadata } from '../../types/provider';

export interface BaseProviderConfig {
  id: string;
  name: string;
  version: string;
  author: string;
  homepage: string;
  priority: number;
  domains: string[];
  pattern: RegExp;
  capabilities: ProviderCapabilities;
  configSchema?: ProviderConfigSchema;
  dependencies?: string[];
  engineCompatibility?: string;
}

/**
 * BaseProvider is the single base class every provider inherits. It turns a
 * declarative config into runtime ProviderMetadata. Providers perform NO
 * downloading, yt-dlp, ffmpeg, or Telegram work. Everything is metadata plus a
 * URL matcher. Subclasses may override supports() for stricter host checks.
 */
export abstract class BaseProvider implements MediaProvider {
  readonly metadata: ProviderMetadata;
  protected readonly pattern: RegExp;

  protected constructor(config: BaseProviderConfig) {
    this.pattern = config.pattern;
    this.metadata = {
      id: config.id,
      name: config.name,
      version: config.version,
      author: config.author,
      homepage: config.homepage,
      priority: config.priority,
      domains: config.domains,
      capabilities: config.capabilities,
      configSchema: config.configSchema ?? [],
      dependencies: config.dependencies ?? [],
      engineCompatibility: config.engineCompatibility ?? '*',
    };
  }

  supports(url: string): boolean {
    return this.pattern.test(url);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
