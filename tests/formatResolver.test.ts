import { describe, expect, it } from 'vitest';
import { FormatResolver } from '../src/downloader/FormatResolver';

const resolver = new FormatResolver();

describe('FormatResolver normalization', () => {
  it('normalizes a video-only format and maps height to a quality label', () => {
    const [format] = resolver.resolve([
      {
        format_id: '137',
        ext: 'mp4',
        vcodec: 'avc1.640028',
        acodec: 'none',
        width: 1920,
        height: 1080,
        fps: 30,
        vbr: 4500,
        filesize: 123456,
      },
    ] as never[]);

    expect(format.kind).toBe('video');
    expect(format.quality).toBe('1080p');
    expect(format.hasVideo).toBe(true);
    expect(format.hasAudio).toBe(false);
    expect(format.resolution).toBe('1920x1080');
    expect(format.bitrate).toBe(4_500_000);
  });

  it('normalizes an audio-only format', () => {
    const [format] = resolver.resolve([
      {
        format_id: '140',
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        abr: 128,
      },
    ] as never[]);

    expect(format.kind).toBe('audio');
    expect(format.quality).toBe('audio');
    expect(format.hasAudio).toBe(true);
    expect(format.hasVideo).toBe(false);
  });

  it('collapses duplicate qualities to the highest bitrate variant', () => {
    const formats = resolver.resolve([
      { format_id: 'a', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, vbr: 1000 },
      { format_id: 'b', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 720, vbr: 2500 },
    ] as never[]);

    const p720 = formats.filter((format) => format.quality === '720p');
    expect(p720).toHaveLength(1);
    expect(p720[0].id).toBe('b');
  });

  it('ignores formats missing an id or extension', () => {
    const formats = resolver.resolve([
      { ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 480 },
      { format_id: 'x', vcodec: 'avc1', acodec: 'none', height: 480 },
    ] as never[]);

    expect(formats).toHaveLength(0);
  });

  it('maps heights across the full quality ladder', () => {
    const heights: Array<[number, string]> = [
      [144, '144p'],
      [240, '240p'],
      [360, '360p'],
      [480, '480p'],
      [720, '720p'],
      [1080, '1080p'],
      [1440, '1440p'],
      [2160, '2160p'],
    ];

    for (const [height, label] of heights) {
      const [format] = resolver.resolve([
        { format_id: `f${height}`, ext: 'mp4', vcodec: 'avc1', acodec: 'none', height },
      ] as never[]);
      expect(format.quality).toBe(label);
    }
  });
});
