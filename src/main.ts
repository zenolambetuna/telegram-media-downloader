import { createBotApplication } from './bot/createBotApplication';
import { logger } from './logger/logger';

async function bootstrap(): Promise<void> {
  const startedAt = new Date().toISOString();
  logger.info({ startedAt, pid: process.pid, node: process.version }, 'application bootstrap starting');

  const app = await createBotApplication();
  await app.start();
  logger.info({ startedAt }, 'application started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.stop();
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'shutdown error');
    }
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // Surface unhandled rejections so the queue worker can be drained by the
  // next shutdown signal rather than leaving jobs in `processing` forever.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ error: error.message, stack: error.stack }, 'uncaughtException');
    void shutdown('SIGTERM');
  });
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, 'application bootstrap failed');
  process.exit(1);
});
