import { describe, expect, it } from 'vitest';
import { buildChoiceKeyboard, buildVideoKeyboard, buildAudioKeyboard } from '../src/bot/keyboards';
import { MediaFormat } from '../src/types/media';

function video(quality: string, id: string, bitrate?: number): MediaFormat {
  return { id, kind: 'video', label: quality, extension: 'mp4', quality, bitrate };
}

function audio(id: string, bitrate: number, codec: string): MediaFormat {
  return { id, kind: 'audio', label: 'audio', extension: 'm4a', quality: 'audio', bitrate, audioCodec: codec };
}

function callbacksOf(keyboard: { inline_keyboard: Array<Array<{ callback_data?: string }>> }): string[] {
  return keyboard.inline_keyboard.flat().map((button) => button.callback_data ?? '');
}

describe('choice keyboard', () => {
  it('shows only buckets that exist', () => {
    const onlyVideo = buildChoiceKeyboard([video('720p', '1')]).inline_keyboard.flat();
    const labels = onlyVideo.map((button) => button.text);
    expect(labels).toContain('🎬 Video');
    expect(labels).not.toContain('🎵 Audio');
    expect(labels).toContain('❌ Cancel');
  });
});

describe('video keyboard', () => {
  it('orders qualities by the standard ladder', () => {
    const keyboard = buildVideoKeyboard([
      video('1080p', 'a', 1000),
      video('360p', 'd'),
      video('720p', 'c', 2000),
    ]);
    const callbacks = callbacksOf(keyboard);
    // ladder order is ascending: 360p, then 720p, then 1080p, then Cancel
    expect(callbacks[0]).toBe('format:d');
    expect(callbacks[1]).toBe('format:c');
    expect(callbacks[2]).toBe('format:a');
  });

  it('dedupes a quality to its highest-bitrate variant', () => {
    const keyboard = buildVideoKeyboard([
      video('720p', 'b', 500),
      video('720p', 'c', 2000),
    ]);
    const callbacks = callbacksOf(keyboard);
    expect(callbacks).toContain('format:c');
    expect(callbacks).not.toContain('format:b');
  });
});

describe('audio keyboard', () => {
  it('sorts audio by bitrate descending', () => {
    const keyboard = buildAudioKeyboard([audio('low', 64000, 'aac'), audio('high', 256000, 'aac')]);
    const callbacks = callbacksOf(keyboard);
    expect(callbacks[0]).toBe('format:high');
  });
});
