import { MediaProvider } from '../types/provider';
import { ENGINE_VERSION } from './engineInfo';
import { satisfies } from '../utils/semver';

export interface ValidationIssue {
  providerId: string;
  reason: string;
}

export interface ValidationOutcome {
  valid: MediaProvider[];
  rejected: ValidationIssue[];
}

/**
 * ProviderValidator enforces plugin integrity before a provider enters the
 * registry. It checks required metadata, duplicate ids, duplicate domains,
 * engine version compatibility, and cross-provider dependency resolution.
 */
export class ProviderValidator {
  validate(providers: MediaProvider[]): ValidationOutcome {
    const valid: MediaProvider[] = [];
    const rejected: ValidationIssue[] = [];
    const seenIds = new Set<string>();
    const seenDomains = new Map<string, string>();

    const structurallyValid: MediaProvider[] = [];
    for (const provider of providers) {
      const reason = this.inspect(provider, seenIds, seenDomains);
      if (reason) {
        rejected.push({ providerId: provider?.metadata?.id ?? 'unknown', reason });
        continue;
      }
      seenIds.add(provider.metadata.id);
      for (const domain of provider.metadata.domains) {
        seenDomains.set(domain.toLowerCase(), provider.metadata.id);
      }
      structurallyValid.push(provider);
    }

    const availableIds = new Set(structurallyValid.map((provider) => provider.metadata.id));
    for (const provider of structurallyValid) {
      const missing = provider.metadata.dependencies.filter((dep) => !availableIds.has(dep));
      if (missing.length > 0) {
        rejected.push({
          providerId: provider.metadata.id,
          reason: `missing dependencies: ${missing.join(', ')}`,
        });
        continue;
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
    const meta = provider?.metadata;
    if (!meta || !meta.id) {
      return 'missing provider id';
    }
    if (!meta.name) {
      return 'missing provider name';
    }
    if (!meta.version) {
      return 'missing provider version';
    }
    if (typeof meta.priority !== 'number') {
      return 'missing or invalid priority';
    }
    if (!Array.isArray(meta.domains) || meta.domains.length === 0) {
      return 'missing supported domains';
    }
    if (typeof provider.supports !== 'function') {
      return 'missing url matcher';
    }
    if (typeof provider.healthCheck !== 'function') {
      return 'missing health check handler';
    }
    if (!meta.capabilities) {
      return 'missing capabilities';
    }
    if (!satisfies(ENGINE_VERSION, meta.engineCompatibility)) {
      return `incompatible engine: needs ${meta.engineCompatibility}, engine is ${ENGINE_VERSION}`;
    }
    if (seenIds.has(meta.id)) {
      return `duplicate provider id: ${meta.id}`;
    }
    for (const domain of meta.domains) {
      const owner = seenDomains.get(domain.toLowerCase());
      if (owner) {
        return `duplicate domain ${domain} already owned by ${owner}`;
      }
    }
    return null;
  }
}
