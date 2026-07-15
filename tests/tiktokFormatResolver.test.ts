import { describe, expect, it } from 'vitest';
import { FormatResolver } from '../src/downloader/FormatResolver';

const resolver = new FormatResolver();

describe('TikTok format resolution', () => {
  it('detects video formats even when vcodec is empty but width/height exist', () => {
    const formats = resolver.resolve([
      {
        format_id: '0',
        ext: 'mp4',
        vcodec: '',
        acodec: 'none',
        width: 1080,
        height: 1920,
        fps: 30,
        vbr: 2000,
        filesize: 5000000,
      },
    ] as never[]);

    expect(formats).toHaveLength(1);
    expect(formats[0].kind).toBe('video');
    expect(formats[0].quality).toBe('1080p');
    expect(formats[0].hasVideo).toBe(true);
    expect(formats[0].hasAudio).toBe(false);
  });

  it('returns both video and audio formats for TikTok', () => {
    const formats = resolver.resolve([
      {
        format_id: '0',
        ext: 'mp4',
        vcodec: '',
        acodec: 'none',
        width: 1080,
        height: 1920,
        fps: 30,
        vbr: 2000,
      },
      {
        format_id: '1',
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        abr: 128,
      },
    ] as never[]);

    expect(formats).toHaveLength(2);
    const videoFormat = formats.find(f => f.kind === 'video');
    const audioFormat = formats.find(f => f.kind === 'audio');
    expect(videoFormat).toBeDefined();
    expect(audioFormat).toBeDefined();
  });
});