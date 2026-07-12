import { SupportedPlatform } from '../types/media';

export interface ProviderOverride {
  enabled?: boolean;
  priority?: number;
}

/**
 * Runtime configuration for providers. Operators can disable a provider or
 * override its priority without touching provider code. In a future Telegram
 * Drive deployment this can be sourced from a database or remote config.
 */
export const providerConfig: Partial<Record<SupportedPlatform, ProviderOverride>> = {};
