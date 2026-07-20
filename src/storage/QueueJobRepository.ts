import { DatabaseConnection } from './Database';
import { ErrorCategory } from '../types/errors';

export type QueueJobStatus = 'pending' | 'processing' | 'dead';
export type QueueJobKind = 'download' | 'retry';

export interface QueueJobRecord {
  id: string;
  kind: QueueJobKind;
  status: QueueJobStatus;
  attempts: number;
  maxAttempts: number;
  url: string;
  formatId: string;
  quality: string;
  userId: number;
  chatId: number;
  ownerId: number;
  requestId?: string;
  createdAt: string;
  updatedAt: string;
  lockedUntil?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastErrorCategory?: ErrorCategory;
  nextAttemptAt?: string;
}

export interface DeadLetterRecord {
  id: string;
  kind: QueueJobKind;
  url: string;
  formatId: string;
  quality: string;
  userId: number;
  chatId: number;
  ownerId: number;
  attempts: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastErrorCategory?: ErrorCategory;
  createdAt: string;
}

/**
 * QueueJobRepository persists download jobs across restarts so the worker
 * can resume pending work after a crash. It also stores the dead-letter queue
 * (jobs that exhausted their retry budget) so operators can inspect and
 * re-queue them later. The in-memory DownloadQueue continues to own
 * concurrency control; this repository owns durability.
 */
export class QueueJobRepository {
  constructor(private readonly database: DatabaseConnection) {}

  async enqueue(record: QueueJobRecord): Promise<void> {
    this.database.connection
      .prepare(
        `INSERT INTO queue_jobs (
          id, kind, status, attempts, max_attempts, url, format_id, quality,
          user_id, chat_id, owner_id, request_id, created_at, updated_at,
          locked_until, last_error_code, last_error_message, last_error_category, next_attempt_at
        ) VALUES (
          @id, @kind, @status, @attempts, @maxAttempts, @url, @formatId, @quality,
          @userId, @chatId, @ownerId, @requestId, @createdAt, @updatedAt,
          @lockedUntil, @lastErrorCode, @lastErrorMessage, @lastErrorCategory, @nextAttemptAt
        )
        ON CONFLICT(id) DO UPDATE SET
          status=excluded.status,
          attempts=excluded.attempts,
          max_attempts=excluded.max_attempts,
          url=excluded.url,
          format_id=excluded.format_id,
          quality=excluded.quality,
          user_id=excluded.user_id,
          chat_id=excluded.chat_id,
          owner_id=excluded.owner_id,
          request_id=excluded.request_id,
          updated_at=excluded.updated_at,
          locked_until=excluded.locked_until,
          last_error_code=excluded.last_error_code,
          last_error_message=excluded.last_error_message,
          last_error_category=excluded.last_error_category,
          next_attempt_at=excluded.next_attempt_at`,
      )
      .run({
        id: record.id,
        kind: record.kind,
        status: record.status,
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        url: record.url,
        formatId: record.formatId,
        quality: record.quality,
        userId: record.userId,
        chatId: record.chatId,
        ownerId: record.ownerId,
        requestId: record.requestId ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lockedUntil: record.lockedUntil ?? null,
        lastErrorCode: record.lastErrorCode ?? null,
        lastErrorMessage: record.lastErrorMessage ?? null,
        lastErrorCategory: record.lastErrorCategory ?? null,
        nextAttemptAt: record.nextAttemptAt ?? null,
      });
  }

  async update(id: string, patch: Partial<Omit<QueueJobRecord, 'id' | 'createdAt'>>): Promise<void> {
    const current = await this.findById(id);
    if (!current) {
      return;
    }
    const merged: QueueJobRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.enqueue(merged);
  }

  async findById(id: string): Promise<QueueJobRecord | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM queue_jobs WHERE id = ? LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async listByStatus(status: QueueJobStatus, limit = 100): Promise<QueueJobRecord[]> {
    const rows = this.database.connection
      .prepare('SELECT * FROM queue_jobs WHERE status = ? ORDER BY created_at ASC LIMIT ?')
      .all(status, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Atomically claim the next pending job whose `next_attempt_at` is due.
   * Returns null when nothing is ready. The row is locked by setting
   * `status='processing'` and `locked_until=now + timeout` so other workers
   * do not pick it up. The returned record reflects the post-claim state.
   */
  async claimNext(now: Date, lockForMs: number): Promise<QueueJobRecord | null> {
    const tx = this.database.connection.transaction(() => {
      const row = this.database.connection
        .prepare(
          `SELECT * FROM queue_jobs
           WHERE status='pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(now.toISOString()) as Record<string, unknown> | undefined;
      if (!row) {
        return null;
      }
      const lockUntil = new Date(now.getTime() + lockForMs).toISOString();
      this.database.connection
        .prepare(
          `UPDATE queue_jobs SET status='processing', locked_until=?, updated_at=? WHERE id=?`,
        )
        .run(lockUntil, now.toISOString(), row.id as string);
      // Reflect the post-claim state so callers see status='processing'.
      row.status = 'processing';
      row.locked_until = lockUntil;
      row.updated_at = now.toISOString();
      return row;
    });
    const row = tx();
    return row ? this.mapRow(row) : null;
  }

  async markProcessing(id: string, lockForMs: number): Promise<void> {
    const lockedUntil = new Date(Date.now() + lockForMs).toISOString();
    this.database.connection
      .prepare(`UPDATE queue_jobs SET status='processing', locked_until=?, updated_at=? WHERE id=?`)
      .run(lockedUntil, new Date().toISOString(), id);
  }

  async markPending(id: string, nextAttemptAt: Date, error?: { code?: string; message?: string; category?: ErrorCategory }): Promise<void> {
    this.database.connection
      .prepare(
        `UPDATE queue_jobs
         SET status='pending', locked_until=NULL,
             last_error_code=?, last_error_message=?, last_error_category=?,
             next_attempt_at=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        error?.code ?? null,
        error?.message ?? null,
        error?.category ?? null,
        nextAttemptAt.toISOString(),
        new Date().toISOString(),
        id,
      );
  }

  async markDead(id: string, error?: { code?: string; message?: string; category?: ErrorCategory }): Promise<void> {
    const tx = this.database.connection.transaction(() => {
      const record = this.findByIdSync(id);
      if (!record) {
        return;
      }
      this.database.connection
        .prepare(
          `UPDATE queue_jobs SET status='dead', locked_until=NULL, updated_at=?,
             last_error_code=?, last_error_message=?, last_error_category=?
           WHERE id=?`,
        )
        .run(
          new Date().toISOString(),
          error?.code ?? null,
          error?.message ?? null,
          error?.category ?? null,
          id,
        );
      this.database.connection
        .prepare(
          `INSERT INTO dead_letter (
            id, kind, url, format_id, quality, user_id, chat_id, owner_id,
            attempts, last_error_code, last_error_message, last_error_category, created_at
          ) VALUES (
            @id, @kind, @url, @formatId, @quality, @userId, @chatId, @ownerId,
            @attempts, @lastErrorCode, @lastErrorMessage, @lastErrorCategory, @createdAt
          )`,
        )
        .run({
          id: record.id,
          kind: record.kind,
          url: record.url,
          formatId: record.formatId,
          quality: record.quality,
          userId: record.userId,
          chatId: record.chatId,
          ownerId: record.ownerId,
          attempts: record.attempts,
          lastErrorCode: error?.code ?? null,
          lastErrorMessage: error?.message ?? null,
          lastErrorCategory: error?.category ?? null,
          createdAt: new Date().toISOString(),
        });
    });
    tx();
  }

  async markCompleted(id: string): Promise<void> {
    this.database.connection
      .prepare(`DELETE FROM queue_jobs WHERE id=?`)
      .run(id);
  }

  async incrementAttempts(id: string): Promise<number> {
    const result = this.database.connection
      .prepare(`UPDATE queue_jobs SET attempts = attempts + 1, updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), id);
    const row = this.database.connection
      .prepare('SELECT attempts FROM queue_jobs WHERE id=? LIMIT 1')
      .get(id) as { attempts: number } | undefined;
    return row?.attempts ?? result.changes;
  }

  async countByStatus(status: QueueJobStatus): Promise<number> {
    const row = this.database.connection
      .prepare('SELECT COUNT(*) AS count FROM queue_jobs WHERE status=?')
      .get(status) as { count: number };
    return row.count;
  }

  async listDeadLetters(limit = 50): Promise<DeadLetterRecord[]> {
    const rows = this.database.connection
      .prepare('SELECT * FROM dead_letter ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapDeadRow(row));
  }

  async requeueFromDeadLetter(id: string, maxAttempts: number): Promise<DeadLetterRecord | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM dead_letter WHERE id=? LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    const dead = this.mapDeadRow(row);
    const tx = this.database.connection.transaction(() => {
      // The dead job's row still exists in queue_jobs with status='dead'.
      // UPSERT reactivates it and resets attempts/errors.
      this.database.connection
        .prepare(
          `INSERT INTO queue_jobs (
            id, kind, status, attempts, max_attempts, url, format_id, quality,
            user_id, chat_id, owner_id, request_id, created_at, updated_at,
            locked_until, last_error_code, last_error_message, last_error_category, next_attempt_at
          ) VALUES (
            @id, @kind, 'pending', 0, @maxAttempts, @url, @formatId, @quality,
            @userId, @chatId, @ownerId, NULL, @createdAt, @updatedAt,
            NULL, NULL, NULL, NULL, NULL
          )
          ON CONFLICT(id) DO UPDATE SET
            status='pending',
            attempts=0,
            max_attempts=excluded.max_attempts,
            locked_until=NULL,
            last_error_code=NULL,
            last_error_message=NULL,
            last_error_category=NULL,
            next_attempt_at=NULL,
            updated_at=excluded.updated_at`,
        )
        .run({
          id: dead.id,
          kind: dead.kind,
          maxAttempts,
          url: dead.url,
          formatId: dead.formatId,
          quality: dead.quality,
          userId: dead.userId,
          chatId: dead.chatId,
          ownerId: dead.ownerId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      this.database.connection.prepare('DELETE FROM dead_letter WHERE id=?').run(dead.id);
    });
    tx();
    return dead;
  }

  async deleteDeadLetter(id: string): Promise<boolean> {
    const result = this.database.connection.prepare('DELETE FROM dead_letter WHERE id=?').run(id);
    return result.changes > 0;
  }

  async deadLetterCount(): Promise<number> {
    const row = this.database.connection
      .prepare('SELECT COUNT(*) AS count FROM dead_letter')
      .get() as { count: number };
    return row.count;
  }

  async clearCompleted(): Promise<number> {
    // `completed` jobs are deleted on success, but flush any leftover dead
    // older than 30 days to keep the table small.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = this.database.connection
      .prepare('DELETE FROM dead_letter WHERE created_at < ?')
      .run(cutoff);
    return result.changes;
  }

  private findByIdSync(id: string): QueueJobRecord | null {
    const row = this.database.connection
      .prepare('SELECT * FROM queue_jobs WHERE id = ? LIMIT 1')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, unknown>): QueueJobRecord {
    return {
      id: row.id as string,
      kind: (row.kind as QueueJobKind) ?? 'download',
      status: row.status as QueueJobStatus,
      attempts: row.attempts as number,
      maxAttempts: row.max_attempts as number,
      url: row.url as string,
      formatId: row.format_id as string,
      quality: row.quality as string,
      userId: row.user_id as number,
      chatId: row.chat_id as number,
      ownerId: row.owner_id as number,
      requestId: (row.request_id as string | null) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      lockedUntil: (row.locked_until as string | null) ?? undefined,
      lastErrorCode: (row.last_error_code as string | null) ?? undefined,
      lastErrorMessage: (row.last_error_message as string | null) ?? undefined,
      lastErrorCategory: (row.last_error_category as ErrorCategory | null) ?? undefined,
      nextAttemptAt: (row.next_attempt_at as string | null) ?? undefined,
    };
  }

  private mapDeadRow(row: Record<string, unknown>): DeadLetterRecord {
    return {
      id: row.id as string,
      kind: (row.kind as QueueJobKind) ?? 'download',
      url: row.url as string,
      formatId: row.format_id as string,
      quality: row.quality as string,
      userId: row.user_id as number,
      chatId: row.chat_id as number,
      ownerId: row.owner_id as number,
      attempts: row.attempts as number,
      lastErrorCode: (row.last_error_code as string | null) ?? undefined,
      lastErrorMessage: (row.last_error_message as string | null) ?? undefined,
      lastErrorCategory: (row.last_error_category as ErrorCategory | null) ?? undefined,
      createdAt: row.created_at as string,
    };
  }
}
