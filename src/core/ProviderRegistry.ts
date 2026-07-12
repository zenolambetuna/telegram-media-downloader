import { AppError } from '../types/errors';
import { SupportedPlatform } from '../types/media';
import { MediaProvider } from '../types/provider';
import { logger } from '../logger/logger';
import { ProviderLoader } from './ProviderLoader';
import { ProviderValidator, ValidationIssue } from './ProviderValidator';
import { ProviderMatcher } from './ProviderMatcher';
import { providerConfig } from '../config/providerConfig';

export interface ProviderStatus {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
}

export interface RegistryHealth {
  loaded: ProviderStatus[];
  disabled: ProviderStatus[];
  failed: ValidationIssue[];
}

/**
 * ProviderRegistry is the runtime home of all discovered plugins. It loads,
 * validates, applies configuration overrides, and resolves providers by URL
 * using priority. Core services never change when a provider is added; only a
 * new provider folder is required.
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
    const discovered = await this.loader.discover();
    const outcome = this.validator.validate(discovered);
    this.failed = outcome.rejected;

    for (const provider of outcome.valid) {
      const override = providerConfig[provider.id];
      const configured = this.applyOverride(provider, override);
      if (override?.enabled === false) {
        this.disabled.push(configured);
      } else {
        this.enabled.push(configured);
      }
    }

    this.enabled.sort((left, right) => right.priority - left.priority);

    logger.info(
      {
        loaded: this.enabled.length,
        disabled: this.disabled.length,
        failed: this.failed.length,
      },
      'provider registry initialized',
    );

    for (const issue of this.failed) {
      logger.warn({ ...issue }, 'provider rejected');
    }
  }

  resolve(url: string): MediaProvider {
    const provider = this.matcher.match(this.enabled, url);
    if (!provider) {
      throw new AppError('Unsupported provider', 'UNSUPPORTED_PROVIDER');
    }
    return provider;
  }

  platformFor(url: string): SupportedPlatform {
    return this.resolve(url).id;
  }

  list(): MediaProvider[] {
    return [...this.enabled];
  }

  health(): RegistryHealth {
    return {
      loaded: this.enabled.map((provider) => this.toStatus(provider, true)),
      disabled: this.disabled.map((provider) => this.toStatus(provider, false)),
      failed: this.failed,
    };
  }

  private applyOverride(provider: MediaProvider, override?: { priority?: number }): MediaProvider {
    if (override?.priority === undefined) {
      return provider;
    }
    return new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === 'priority') {
          return override.priority;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private toStatus(provider: MediaProvider, enabled: boolean): ProviderStatus {
    return {
      id: provider.id,
      name: provider.name,
      priority: provider.priority,
      enabled,
    };
  }
}
