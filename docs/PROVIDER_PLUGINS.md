# Provider Plugin System

Providers are real plugins. Adding one requires only creating a new folder under `src/providers/`. No core file, engine, storage, bot, or registry is ever edited.

## The contract

Every provider folder exports a default `ProviderManifest` from its `index.ts`. The manifest has a single `create()` method that returns a `MediaProvider`. Providers extend the shared `BaseProvider` and declare:

- **id** stable platform identifier
- **name** human readable name
- **priority** higher wins when multiple providers match
- **domains** supported domains, validated for duplicates
- **pattern** URL matcher
- **capabilities** what the provider supports

## Components

| Component | Responsibility |
| --- | --- |
| `ProviderLoader` | Auto-discovers provider folders and imports their manifests. |
| `ProviderFactory` | Instantiates a provider from a manifest, isolating failures. |
| `ProviderValidator` | Rejects invalid, duplicate-id, or duplicate-domain providers. |
| `ProviderMatcher` | Picks the highest-priority provider that matches a URL. |
| `ProviderRegistry` | Loads, validates, configures, and resolves providers at runtime. |
| `BaseProvider` | The single base class every provider inherits. |

## Auto discovery

On startup `ProviderRegistry.initialize()`:

1. `ProviderLoader` scans `src/providers/`, skipping `shared`.
2. Each folder's default manifest is imported.
3. `ProviderFactory` builds each provider, isolating construction errors.
4. `ProviderValidator` rejects invalid providers.
5. Configuration overrides enable/disable providers and override priority.
6. Valid, enabled providers are sorted by priority and registered.

## Capabilities

Providers advertise capabilities via `defineCapabilities`. Anything unspecified defaults to false:

- supportsVideo
- supportsAudio
- supportsPlaylist
- supportsShorts
- supportsReels
- supportsStories
- supportsLive
- supportsPrivate
- supportsAgeRestricted
- supportsLogin

## Priority

When multiple providers match a URL, the highest `priority` wins. Ties fall back to declaration order. Priority can be overridden at runtime via `providerConfig` without editing provider code.

## Validation rules

A provider is rejected when it has: missing id, missing name, invalid priority, no domains, no URL matcher, no health check, no capabilities, a duplicate id, or a domain already owned by another provider. Rejected providers are surfaced under failed health, never silently dropped.

## Health

`ProviderRegistry.health()` returns loaded, disabled, and failed providers. The admin `/providers` command renders this live.

## Configuration

`src/config/providerConfig.ts` allows enabling/disabling a provider and overriding priority at runtime. In a future Telegram Drive deployment this can be backed by a database or remote config.

## Create a new provider in under five minutes

1. Create a folder: `src/providers/dailymotion/`
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
      priority: 70,
      domains: ['dailymotion.com', 'dai.ly'],
      pattern: /(?:dailymotion\.com|dai\.ly)/i,
      capabilities: defineCapabilities({ supportsVideo: true, supportsAudio: true }),
    });
  }
}

const manifest: ProviderManifest = { create: () => new DailymotionProvider() };
export default manifest;
```

3. Add `dailymotion` to the `SupportedPlatform` union in `src/types/media.ts`.
4. Start the bot. It is auto-discovered, validated, and registered.

That is the whole process. No engine, storage, bot, or registry edits.

## Note on the platform union

The only shared touch point is the `SupportedPlatform` type union, which exists purely for compile-time safety across the persistence layer. It is a type, not logic. If you prefer zero shared edits, widen `SupportedPlatform` to `string`; the runtime plugin system does not depend on the union.
