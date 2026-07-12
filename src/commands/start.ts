import { Bot } from 'grammy';
import { BotContext } from '../types/bot';

export function registerStartCommand(bot: Bot<BotContext>): void {
  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Welcome. Send a supported media URL and I will inspect it, show available formats, and store the final file in the Telegram Drive channel.',
    );
  });
}
