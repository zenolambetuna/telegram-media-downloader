import { describe, expect, it } from 'vitest';
import manifest from '../src/providers/youtube';

const provider = manifest.create();

describe('YouTube provider metadata', () => {
  it('exposes complete runtime metadata', () => {
    expect(provider.metadata.id).toBe('youtube');
    expect(provider.metadata.name).toBe('YouTube');
    expect(provider.metadata.version).toBe('1.0.0');
    expect(provider.metadata.priority).toBe(100);
    expect(provider.metadata.domains).toContain('music.youtube.com');
    expect(provider.metadata.domains).toContain('m.youtube.com');
    expect(provider.metadata.domains).toContain('youtu.be');
  });

  it('advertises the expected capabilities', () => {
    const caps = provider.metadata.capabilities;
    expect(caps.supportsVideo).toBe(true);
    expect(caps.supportsAudio).toBe(true);
    expect(caps.supportsPlaylist).toBe(true);
    expect(caps.supportsShorts).toBe(true);
    expect(caps.supportsLive).toBe(true);
    expect(caps.supportsAgeRestricted).toBe(true);
    expect(caps.supportsPrivate).toBe(true);
  });

  it('declares a valid manifest version', () => {
    expect(manifest.manifestVersion).toBe(1);
  });
});

describe('YouTube provider URL detection', () => {
  const shouldMatch = [
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/abc123',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/live/xyz789',
  ];

  const shouldNotMatch = [
    'https://vimeo.com/12345',
    'https://notyoutube.com/watch?v=1',
    'https://youtube.com.evil.tld/watch?v=1',
    'https://example.com/youtube.com',
    'not a url',
    '',
  ];

  for (const url of shouldMatch) {
    it(`matches ${url}`, () => {
      expect(provider.supports(url)).toBe(true);
    });
  }

  for (const url of shouldNotMatch) {
    it(`rejects ${url}`, () => {
      expect(provider.supports(url)).toBe(false);
    });
  }
});

describe('YouTube provider health', () => {
  it('reports healthy', async () => {
    await expect(provider.healthCheck()).resolves.toBe(true);
  });
});
