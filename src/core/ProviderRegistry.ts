import { MediaProvider } from '../types/provider';
import { UnsupportedProviderError } from '../utils/errors';

export class ProviderRegistry {
  constructor(private readonly providers: MediaProvider[]) {}

  resolve(url: string): MediaProvider {
    const provider = this.providers.find((item) => item.supports(url));
    if (!provider) {
      throw new UnsupportedProviderError();
    }
    return provider;
  }
}
