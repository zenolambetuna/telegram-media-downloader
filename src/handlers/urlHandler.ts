import { InlineKeyboard } from 'grammy';
import { MediaCacheService } from '../cache/MediaCacheService';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { BotContext } from '../types/bot';
import { InvalidUrlError } from '../utils/errors';
import { isValidUrl, normalizeUrl } from '../utils/url';

export function createUrlHandler(
  providerRegistry: ProviderRegistry,
  cacheService: MediaCacheService,
) {
  return async (ctx: BotContext): Promise<void> => {
    const text = ctx.message?.text?.trim();
    if (!text) {
      return;
    }

    if (!isValidUrl(text)) {
      throw new InvalidUrlError();
    }

    const provider = providerRegistry.resolve(text);
    const metadata = await provider.getMetadata(text);
    const canonicalUrl = normalizeUrl(metadata.canonicalUrl);
    const cached = await cacheService.get(canonicalUrl);

    if (cached) {
      await ctx.api.copyMessage(ctx.chat.id, process.env.CHANNEL_ID ?? '', cached.messageId);
      await ctx.reply('cache hit, skipped the whole circus');
      return;
    }

    ctx.session.pendingUrl = text;
    ctx.session.pendingMetadata = metadata;

    const videoFormats = metadata.formats.filter((format) => format.kind === 'video');
    const audioFormats = metadata.formats.filter((format) => format.kind === 'audio');

    const keyboard = new InlineKeyboard();
    if (videoFormats.length > 0) {
      keyboard.text('🎥 Video', 'choose:video');
    }
    if (audioFormats.length > 0) {
      keyboard.text('🎵 Audio', 'choose:audio');
    }
    keyboard.text('❌ Cancel', 'choose:cancel');

    await ctx.reply(
      `title: ${metadata.title}\nduration: ${metadata.duration ?? 'unknown'}\nuploader: ${metadata.uploader ?? 'unknown'}\nfile size: ${metadata.filesize ?? 'unknown'}`,
      {
        reply_markup: keyboard,
      },
    );
  };
}
