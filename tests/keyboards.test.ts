import { describe, expect, it } from 'vitest';
import { buildChoiceKeyboard, buildVideoKeyboard, buildAudioKeyboard } from '../src/bot/keyboards';
import { MediaFormat } from '../src/types/media';

function video(quality: string, id: string, bitrate?: number): MediaFormat {
  return { id, kind: 'video', label: quality, extension: 'mp4', quality, bitrate };
}

function audio(id: string, bitrate: number, codec: string): MediaFormat {
  return { id, kind: 'audio', label: 'audio', extension: 'm4a', quality: 'audio', bitrate, audioCodec: codec };
}

function callbacksOf(keyboard: { inline_keyboard: unknown[][] }): string[] {
  return keyboard.inline_keyboard
    .flat()
    .map((button) => (button as { callback_data?: string }).callback_data)
    .filter((value): value is string => typeof value === 'string');
}

describe('choice keyboard', () => {
  it('shows only buckets that exist', () => {
    const labels = buildChoiceKeyboard([video('720p', '1')]).inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('🎬 Video');
    expect(labels).not.toContain('🎵 Audio');
    expect(labels).toContain('❌ Cancel');
  });

  it('shows audio bucket when audio formats exist', () => {
    const labels = buildChoiceKeyboard([audio('a', 128000, 'aac')]).inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('🎵 Audio');
    expect(labels).not.toContain('🎬 Video');
  });
});

describe('video keyboard', () => {
  it('dedupes a quality to its highest-bitrate variant', () => {
    const keyboard = buildVideoKeyboard([
      video('1080p', 'a', 1000),
      video('720p', 'b', 500),
      video('720p', 'c', 2000),
      video('360p', 'd'),
    ]);
    const callbacks = callbacksOf(keyboard);
    // 720p resolves to the higher-bitrate variant c, not b
    expect(callbacks).toContain('format:c');
    expect(callbacks).not.toContain('format:b');
  });

  it('orders qualities by the standard ladder, highest first', () => {
    const keyboard = buildVideoKeyboard([
      video('360p', 'd'),
      video('1080p', 'a'),
      video('720p', 'c'),
    ]);
    const callbacks = callbacksOf(keyboard).filter((value) => value.startsWith('format:'));
    expect(callbacks).toEqual(['format:a', 'format:c', 'format:d']);
  });
});

describe('audio keyboard', () => {
  it('sorts audio by bitrate descending', () => {
    const keyboard = buildAudioKeyboard([audio('low', 64000, 'aac'), audio('high', 256000, 'aac')]);
    const callbacks = callbacksOf(keyboard);
    expect(callbacks[0]).toBe('format:high');
  });
});
