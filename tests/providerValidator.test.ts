import { describe, expect, it } from 'vitest';
import { ProviderValidator } from '../src/core/ProviderValidator';
import { MediaProvider } from '../src/types/provider';

function makeProvider(overrides: Partial<MediaProvider['metadata']>, supports = true): MediaProvider {
  return {
    metadata: {
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      author: 'test',
      homepage: 'https://test',
      priority: 50,
      domains: ['test.com'],
      capabilities: {
        supportsVideo: true,
        supportsAudio: false,
        supportsPlaylist: false,
        supportsShorts: false,
        supportsReels: false,
        supportsStories: false,
        supportsLive: false,
        supportsPrivate: false,
        supportsAgeRestricted: false,
        supportsLogin: false,
      },
      configSchema: [],
      dependencies: [],
      engineCompatibility: '^1.0.0',
      ...overrides,
    },
    supports: () => supports,
    healthCheck: async () => true,
  };
}

const validator = new ProviderValidator();

describe('ProviderValidator', () => {
  it('accepts a well-formed provider', () => {
    const outcome = validator.validate([makeProvider({ id: 'ok', domains: ['ok.com'] })]);
    expect(outcome.valid).toHaveLength(1);
    expect(outcome.rejected).toHaveLength(0);
  });

  it('rejects duplicate ids', () => {
    const outcome = validator.validate([
      makeProvider({ id: 'dup', domains: ['a.com'] }),
      makeProvider({ id: 'dup', domains: ['b.com'] }),
    ]);
    expect(outcome.valid).toHaveLength(1);
    expect(outcome.rejected[0].reason).toContain('duplicate provider id');
  });

  it('rejects duplicate domains', () => {
    const outcome = validator.validate([
      makeProvider({ id: 'one', domains: ['shared.com'] }),
      makeProvider({ id: 'two', domains: ['shared.com'] }),
    ]);
    expect(outcome.rejected.some((issue) => issue.reason.includes('duplicate domain'))).toBe(true);
  });

  it('rejects incompatible engine versions', () => {
    const outcome = validator.validate([
      makeProvider({ id: 'future', domains: ['future.com'], engineCompatibility: '^99.0.0' }),
    ]);
    expect(outcome.rejected[0].reason).toContain('incompatible engine');
  });

  it('rejects providers with missing dependencies', () => {
    const outcome = validator.validate([
      makeProvider({ id: 'needy', domains: ['needy.com'], dependencies: ['ghost'] }),
    ]);
    expect(outcome.rejected[0].reason).toContain('missing dependencies');
  });

  it('accepts providers whose dependencies are present', () => {
    const outcome = validator.validate([
      makeProvider({ id: 'base', domains: ['base.com'] }),
      makeProvider({ id: 'ext', domains: ['ext.com'], dependencies: ['base'] }),
    ]);
    expect(outcome.valid).toHaveLength(2);
  });
});
