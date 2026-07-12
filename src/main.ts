import { createBotApplication } from './bot/createBotApplication';
import { logger } from './logger/logger';

async function bootstrap(): Promise<void> {
  const app = await createBotApplication();
  await app.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    await app.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ error }, 'application bootstrap failed');
  process.exit(1);
});
