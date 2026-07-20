import { Api } from 'grammy';
import { config } from '../config/env';
import { logger } from '../logger/logger';
import { DatabaseConnection } from '../storage/Database';
import { DriveApiClient } from './DriveApiClient';

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  detail?: string;
  durationMs?: number;
}

export interface StartupHealthReport {
  status: HealthStatus;
  startedAt: string;
  components: ComponentHealth[];
}

/**
 * HealthCheck runs a startup probe over every external dependency of the
 * engine: local SQLite, the Telegram Bot API (getMe), the Telegram API root
 * (when a local Bot API server is configured), and the Drive Bridge API
 * (`/api/v1/integration/health`) when configured. The first three are
 * required; the Drive API is optional. Failures print a clear status block
 * but do not crash the bot unless `HEALTH_CHECK_FAIL_ON_DRIVE_ERROR` is set.
 */
export class HealthCheck {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly botApi: Api,
    private readonly drive: DriveApiClient,
  ) {}

  async runStartup(): Promise<StartupHealthReport> {
    const components: ComponentHealth[] = [];

    components.push(await this.checkDatabase());
    components.push(await this.checkTelegramBot());
    components.push(await this.checkTelegramApiRoot());
    components.push(await this.checkDriveApi());

    const status = aggregateStatus(components);
    const report: StartupHealthReport = {
      status,
      startedAt: new Date().toISOString(),
      components,
    };

    this.logReport(report);
    return report;
  }

  async runRuntime(): Promise<StartupHealthReport> {
    return await this.runStartup();
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const start = Date.now();
    try {
      this.database.connection.prepare('SELECT 1 AS one').get();
      return {
        name: 'database',
        status: 'ok',
        detail: 'sqlite SELECT 1 ok',
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        name: 'database',
        status: 'down',
        detail: error instanceof Error ? error.message : 'unknown error',
        durationMs: Date.now() - start,
      };
    }
  }

  private async checkTelegramBot(): Promise<ComponentHealth> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.HEALTH_CHECK_TIMEOUT_MS);
    try {
      const me = await this.botApi.getMe();
      return {
        name: 'telegram_bot',
        status: 'ok',
        detail: `@${me.username} (id=${me.id})`,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        name: 'telegram_bot',
        status: 'down',
        detail: error instanceof Error ? error.message : 'unknown error',
        durationMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkTelegramApiRoot(): Promise<ComponentHealth> {
    const start = Date.now();
    if (!config.TELEGRAM_API_ROOT) {
      return {
        name: 'telegram_api',
        status: 'ok',
        detail: 'default Telegram Bot API',
        durationMs: 0,
      };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.HEALTH_CHECK_TIMEOUT_MS);
      try {
        const response = await fetch(config.TELEGRAM_API_ROOT, {
          method: 'GET',
          signal: controller.signal,
        });
        if (!response.ok && response.status !== 404) {
          return {
            name: 'telegram_api',
            status: 'degraded',
            detail: `api root returned ${response.status}`,
            durationMs: Date.now() - start,
          };
        }
        return {
          name: 'telegram_api',
          status: 'ok',
          detail: config.TELEGRAM_API_ROOT,
          durationMs: Date.now() - start,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return {
        name: 'telegram_api',
        status: 'down',
        detail: error instanceof Error ? error.message : 'unknown error',
        durationMs: Date.now() - start,
      };
    }
  }

  private async checkDriveApi(): Promise<ComponentHealth> {
    const start = Date.now();
    if (!this.drive.configured) {
      return {
        name: 'drive_api',
        status: 'ok',
        detail: 'not configured (skipped)',
        durationMs: 0,
      };
    }
    try {
      const result = await this.drive.health();
      const status: HealthStatus =
        result.status === 'ok' ? 'ok' : result.status === 'degraded' ? 'degraded' : 'down';
      return {
        name: 'drive_api',
        status,
        detail: `${result.status}${result.version ? ` v${result.version}` : ''}`,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        name: 'drive_api',
        status: 'down',
        detail: error instanceof Error ? error.message : 'unknown error',
        durationMs: Date.now() - start,
      };
    }
  }

  private logReport(report: StartupHealthReport): void {
    const summary = report.components.map((c) => `${c.name}=${c.status}(${c.durationMs}ms)`).join(' ');
    if (report.status === 'ok') {
      logger.info({ status: report.status, startedAt: report.startedAt, summary }, 'startup health ok');
    } else if (report.status === 'degraded') {
      logger.warn({ status: report.status, startedAt: report.startedAt, components: report.components }, 'startup health degraded');
    } else {
      logger.error({ status: report.status, startedAt: report.startedAt, components: report.components }, 'startup health down');
    }
  }
}

function aggregateStatus(components: ComponentHealth[]): HealthStatus {
  const required = components.filter((c) => c.name !== 'drive_api');
  if (required.some((c) => c.status === 'down')) {
    return 'down';
  }
  if (components.some((c) => c.status === 'down') && config.HEALTH_CHECK_FAIL_ON_DRIVE_ERROR) {
    return 'down';
  }
  if (components.some((c) => c.status === 'degraded')) {
    return 'degraded';
  }
  return 'ok';
}
