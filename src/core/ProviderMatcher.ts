import { MediaProvider } from '../types/provider';

/**
 * ProviderMatcher selects the best provider for a URL. When multiple providers
 * match, the highest priority wins. Ties fall back to declaration order.
 */
export class ProviderMatcher {
  match(providers: MediaProvider[], url: string): MediaProvider | null {
    const candidates = providers.filter((provider) => provider.supports(url));
    if (candidates.length === 0) {
      return null;
    }
    return candidates.sort((left, right) => right.priority - left.priority)[0];
  }
}
