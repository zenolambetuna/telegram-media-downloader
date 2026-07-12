import { AppError } from '../types/errors';
import { MediaProvider, ProviderMetadata } from '../types/provider';
import { logger } from '../logger/logger';
import { ProviderLoader } from './ProviderLoader';
import { ProviderValidator, ValidationIssue } from './ProviderValidator';
import { ProviderMatcher } from './ProviderMatcher';
import { providerConfig } from '../config/providerConfig';

export interface RegistryHealth {
  loaded: ProviderMetadata[];
  disabled: ProviderMetadata[];
  failed: ValidationIssue[];
}

/**
 * ProviderRegistry is the runtime home of all discovered plugins. It loads,
 * validates, applies configuration overrides, and resolves providers by URL
 * using priority. It exposes full runtime metadata so the admin layer lists
 * every provider automatically. Core services never change when a provider is
 * added; only a new provider folder is required.
 */
export class ProviderRegistry {
  private enabled: MediaProvider[] = [];
  private disabled: MediaProvider[] = [];
  private failed: ValidationIssue[] = [];

  constructor(
    private readonly loader: ProviderLoader,
    private readonly validator: ProviderValidator,
    private readonly matcher: ProviderMatcher,
  ) {}

  async initialize(): Promise<void> {
    this.enabled = [];
    this.disabled = [];
    this.failed = [];

    const discovered = await this.loader.discover();
    const outcome = this.validator.validate(discovered);
    this.failed = outcome.rejected;

    for (const provider of outcome.valid) {
      const override = providerConfig[provider.metadata.id];
      const configured = this.applyOverride(provider, override);
      if (override?.enabled === false) {
        this.disabled.push(configured);
      } else {
        this.enabled.push(configured);
      }
    }

    this.enabled.sort((left, right) => right.metadata.priority - left.metadata.priority);

    logger.info(
      { loaded: this.enabled.length, disabled: this.disabled.length, failed: this.failed.length },
      'provider registry initialized',
    );
    for (const issue of this.failed) {
      logger.warn({ ...issue }, 'provider rejected');
    }
  }

  /** Hot-reload: rediscover providers without restarting the process. */
  async reload(): Promise<RegistryHealth> {
    await this.initialize();
    return this.health();
  }

  resolve(url: string): MediaProvider {
    const provider = this.matcher.match(this.enabled, url);
    if (!provider) {
      throw new AppError('Unsupported provider', 'UNSUPPORTED_PROVIDER');
    }
    return provider;
  }

  platformFor(url: string): string {
    return this.resolve(url).metadata.id;
  }

  list(): MediaProvider[] {
    return [...this.enabled];
  }

  health(): RegistryHealth {
    return {
      loaded: this.enabled.map((provider) => provider.metadata),
      disabled: this.disabled.map((provider) => provider.metadata),
      failed: this.failed,
    };
  }

  private applyOverride(provider: MediaProvider, override?: { priority?: number }): MediaProvider {
    if (override?.priority === undefined) {
      return provider;
    }
    const patchedMetadata: ProviderMetadata = { ...provider.metadata, priority: override.priority };
    return {
      metadata: patchedMetadata,
      supports: (url: string) => provider.supports(url),
      healthCheck: () => provider.healthCheck(),
    };
  }
}
