import { MediaProvider } from '../types/provider';
import { AppError } from '../types/errors';

export class ProviderRegistry {
  constructor(private readonly providers: MediaProvider[]) {}

  resolve(url: string): MediaProvider {
    const provider = this.providers.find((item) => item.supports(url));
    if (!provider) {
      throw new AppError('Unsupported provider', 'UNSUPPORTED_PROVIDER');
    }
    return provider;
  }

  list(): MediaProvider[] {
    return [...this.providers];
  }
}
