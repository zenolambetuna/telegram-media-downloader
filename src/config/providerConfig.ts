export interface ProviderOverride {
  enabled?: boolean;
  priority?: number;
}

/**
 * Runtime configuration for providers, keyed by provider id (a runtime string,
 * not a compile-time union). Operators can disable a provider or override its
 * priority without touching provider code. In a future Telegram Drive
 * deployment this can be sourced from a database or remote config.
 */
export const providerConfig: Record<string, ProviderOverride> = {};
