# Provider Plugin System

Providers are true, self-registering plugins, modeled after enterprise plugin systems like VS Code extensions and IntelliJ plugins. Adding a provider requires only creating a new folder under `src/providers/`. Nothing in `types/`, the engine, registry, storage, bot, or config is ever edited.

## Zero core edit is now real

The last compile-time dependency, the `SupportedPlatform` union, is gone. Platform identity is a runtime string carried in `ProviderMetadata`. `SupportedPlatform` remains as a `string` alias purely for backward compatibility, so existing imports keep compiling.

## The contract

Every provider folder default-exports a `ProviderManifest` from `index.ts`:

```ts
export interface ProviderManifest {
  manifestVersion: 1;
  create(): MediaProvider;
}
```

Providers extend `BaseProvider`, which turns a declarative config into runtime `ProviderMetadata`.

## Provider metadata

Every provider exposes, at runtime:

- id
- name
- version
- author
- homepage
- priority
- supported domains
- capabilities
- configuration schema
- dependencies
- engine compatibility (semver range)

## Components

| Component | Responsibility |
| --- | --- |
| `ProviderLoader` | Auto-discovers provider folders and imports their manifests at runtime. |
| `ProviderFactory` | Builds a provider from a manifest, checks manifest version, isolates failures. |
| `ProviderValidator` | Validates metadata, duplicate ids, duplicate domains, engine compatibility, dependencies. |
| `ProviderMatcher` | Picks the highest-priority provider that matches a URL. |
| `ProviderRegistry` | Loads, validates, configures, resolves, and hot-reloads providers. |
| `BaseProvider` | The single base class every provider inherits. |

## Auto discovery

On startup, and on `reload()`, `ProviderRegistry.initialize()`:

1. `ProviderLoader` scans `providers/`, skipping `shared`.
2. Each folder's default manifest is imported dynamically.
3. `ProviderFactory` builds each provider and checks `manifestVersion`.
4. `ProviderValidator` validates structure, engine compatibility, and dependencies.
5. Config overrides enable/disable and re-prioritize.
6. Valid, enabled providers are sorted by priority and registered.

## Dependency validation

A provider may declare `dependencies: ['otherProviderId']`. If a dependency is not present and valid, the provider is rejected with a clear reason. This lets composite or extension providers require a base provider safely.

## Version compatibility

Each provider declares `engineCompatibility` as a semver range (for example `^1.0.0`). The validator checks it against `ENGINE_VERSION`. Incompatible providers are rejected, not loaded. The engine version lives in `src/core/engineInfo.ts` and is bumped only on breaking provider-contract changes.

## Hot loading

`ProviderRegistry.reload()` rediscovers and re-validates providers without restarting the process, returning fresh health. Dropping a new compiled provider folder into `dist/providers` and calling reload registers it live.

## Health and admin

`ProviderRegistry.health()` returns full metadata for loaded, disabled, and failed providers. The admin `/providers` command renders every provider automatically, including version and author. Nothing is hardcoded.

## Configuration

`src/config/providerConfig.ts` is keyed by provider id (a runtime string). Operators can disable a provider or override its priority without touching provider code.

## Create a new provider in under five minutes

1. Create `src/providers/dailymotion/`
2. Add `index.ts`:

```ts
import { BaseProvider } from '../shared/BaseProvider';
import { defineCapabilities } from '../shared/capabilities';
import { ProviderManifest } from '../../types/provider';

class DailymotionProvider extends BaseProvider {
  constructor() {
    super({
      id: 'dailymotion',
      name: 'Dailymotion',
      version: '1.0.0',
      author: 'you',
      homepage: 'https://dailymotion.com',
      priority: 70,
      domains: ['dailymotion.com', 'dai.ly'],
      pattern: /(?:dailymotion\.com|dai\.ly)/i,
      engineCompatibility: '^1.0.0',
      capabilities: defineCapabilities({ supportsVideo: true, supportsAudio: true }),
    });
  }
}

const manifest: ProviderManifest = { manifestVersion: 1, create: () => new DailymotionProvider() };
export default manifest;
```

3. Build and restart. It is auto-discovered, validated, and registered.

That is the entire process. No edits to `types/`, engine, registry, storage, bot, or config. Copying a compiled provider folder into `dist/providers/` and restarting works with no other change.

## Backward compatibility

- `SupportedPlatform` still exists as a `string` alias.
- All persistence, storage, and pipeline code continues to treat provider identity as a string.
- Existing providers keep working unchanged aside from richer metadata.
