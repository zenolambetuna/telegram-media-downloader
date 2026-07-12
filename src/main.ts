import { createBot } from './bot/createBot';
import { config } from './config/env';
import { logger } from './logs/logger';

async function bootstrap(): Promise<void> {
  const bot = createBot();

  process.once('SIGINT', async () => {
    logger.info('received SIGINT, stopping bot');
    await bot.stop();
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    logger.info('received SIGTERM, stopping bot');
    await bot.stop();
    process.exit(0);
  });

  await bot.api.getMe();
  await bot.start();

  logger.info({ username: config.botToken.slice(0, 8) }, 'bot started');
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ error }, 'failed to bootstrap application');
  process.exit(1);
});
