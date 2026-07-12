/**
 * Runtime provider contract. There is no compile-time platform union anymore.
 * A provider declares all of its identity as runtime metadata. Adding a new
 * provider requires only a new folder under src/providers/ and nothing else.
 */

export interface ProviderCapabilities {
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsPlaylist: boolean;
  supportsShorts: boolean;
  supportsReels: boolean;
  supportsStories: boolean;
  supportsLive: boolean;
  supportsPrivate: boolean;
  supportsAgeRestricted: boolean;
  supportsLogin: boolean;
}

/**
 * A single configuration field a provider can expose. The admin layer can
 * render these dynamically. Values are resolved at runtime, never compiled in.
 */
export interface ProviderConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  default?: string | number | boolean;
  secret?: boolean;
}

export type ProviderConfigSchema = ProviderConfigField[];

/**
 * Declarative, fully runtime metadata for a provider. This replaces every
 * compile-time union. The registry and admin API read this directly.
 */
export interface ProviderMetadata {
  id: string;
  name: string;
  version: string;
  author: string;
  homepage: string;
  priority: number;
  domains: string[];
  capabilities: ProviderCapabilities;
  configSchema: ProviderConfigSchema;
  /** Provider ids this provider depends on being present. */
  dependencies: string[];
  /** Semver range of engine this provider is compatible with. */
  engineCompatibility: string;
}

export interface MediaProvider {
  readonly metadata: ProviderMetadata;
  supports(url: string): boolean;
  healthCheck(): Promise<boolean>;
}

/**
 * Every provider folder default-exports a manifest. The manifest is the only
 * discovery surface. The loader imports it, the factory builds it.
 */
export interface ProviderManifest {
  /** Manifest schema version, for forward compatibility of the manifest itself. */
  manifestVersion: 1;
  create(): MediaProvider;
}
