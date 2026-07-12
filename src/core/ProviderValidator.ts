import { MediaProvider } from '../types/provider';

export interface ValidationIssue {
  providerId: string;
  reason: string;
}

export interface ValidationOutcome {
  valid: MediaProvider[];
  rejected: ValidationIssue[];
}

/**
 * ProviderValidator enforces plugin integrity before a provider is allowed
 * into the registry. It rejects providers with missing identity, duplicate
 * ids, duplicate domains, or missing handlers.
 */
export class ProviderValidator {
  validate(providers: MediaProvider[]): ValidationOutcome {
    const valid: MediaProvider[] = [];
    const rejected: ValidationIssue[] = [];
    const seenIds = new Set<string>();
    const seenDomains = new Map<string, string>();

    for (const provider of providers) {
      const reason = this.inspect(provider, seenIds, seenDomains);
      if (reason) {
        rejected.push({ providerId: provider?.id ?? 'unknown', reason });
        continue;
      }

      seenIds.add(provider.id);
      for (const domain of provider.domains) {
        seenDomains.set(domain.toLowerCase(), provider.id);
      }
      valid.push(provider);
    }

    return { valid, rejected };
  }

  private inspect(
    provider: MediaProvider,
    seenIds: Set<string>,
    seenDomains: Map<string, string>,
  ): string | null {
    if (!provider || !provider.id) {
      return 'missing provider id';
    }
    if (!provider.name) {
      return 'missing provider name';
    }
    if (typeof provider.priority !== 'number') {
      return 'missing or invalid priority';
    }
    if (!Array.isArray(provider.domains) || provider.domains.length === 0) {
      return 'missing supported domains';
    }
    if (typeof provider.supports !== 'function') {
      return 'missing url matcher';
    }
    if (typeof provider.healthCheck !== 'function') {
      return 'missing health check handler';
    }
    if (!provider.capabilities) {
      return 'missing capabilities';
    }
    if (seenIds.has(provider.id)) {
      return `duplicate provider id: ${provider.id}`;
    }
    for (const domain of provider.domains) {
      const owner = seenDomains.get(domain.toLowerCase());
      if (owner) {
        return `duplicate domain ${domain} already owned by ${owner}`;
      }
    }
    return null;
  }
}
