import { MediaProvider } from '../types/provider';
import { AppError } from '../types/errors';
import { SupportedPlatform } from '../types/media';

export class ProviderRegistry {
  constructor(private readonly providers: MediaProvider[]) {}

  resolve(url: string): MediaProvider {
    const provider = this.providers.find((item) => item.supports(url));
    if (!provider) {
      throw new AppError('Unsupported provider', 'UNSUPPORTED_PROVIDER');
    }
    return provider;
  }

  platformFor(url: string): SupportedPlatform {
    return this.resolve(url).platform;
  }

  list(): MediaProvider[] {
    return [...this.providers];
  }
}
