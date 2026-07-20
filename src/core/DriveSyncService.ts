import { logger, loggerFor } from '../logger/logger';
import { config } from '../config/env';
import { DriveApiClient, DriveCallResult } from './DriveApiClient';
import { MetricsCollector, DriveServiceName } from './MetricsCollector';
import { classifyDriveResult, driveBackoffMs } from './DriveSyncPolicy';
import {
  CreateMediaRequest,
  CreateFolderRequest,
  RecentRequest,
  FavoriteRequest,
  // Stage 4.1
  RenameFolderRequest,
  MoveFolderRequest,
  UpdateShareRequest,
  MoveToTrashRequest,
  RestoreTrashRequest,
  CleanupRecentRequest,
  UpdateCollaboratorRequest,
} from './DriveBridgeContract';

/**
 * DriveSyncService is the Stage 4.0 orchestration layer that runs the
 * post-upload and post-download Drive sync. It is the ONLY place that
 * decides when and how to call the Drive Bridge after a download.
 *
 * Design rules (per the Stage 4.0 brief):
 *  - All sync is asynchronous and fire-and-forget. The downloader never
 *    fails a download because the Drive is offline.
 *  - Retry policy: 401/403/422 → permanent (no retry); 429/5xx/network →
 *    retry with exponential backoff up to `DRIVE_SYNC_MAX_ATTEMPTS`.
 *  - Every mutating request carries an `Idempotency-Key` derived from the
 *    queue job id so retries after a network failure do not create
 *    duplicate records.
 *  - All sync attempts record metrics (success/failed/retry/latency) so
 *    the admin `/metrics` command and the `/drivehealth` probe can
 *    surface the sync health to operators.
 *
 * Flow:
 *   upload Telegram succeeds
 *     → POST /media          (createMedia)
 *     → create/update folder  (createFolder + addMediaToFolder)
 *     → POST /media/:id/sync (syncMedia)        [best-effort]
 *
 *   download completes
 *     → POST /recent          (recordRecent)
 *     → POST /favorites       (addFavorite)      [only if favorite flag set]
 *
 * The service swallows every sync error: a failed sync is logged and
 * counted, but the download itself is reported as successful to the user.
 */
export interface PostUploadSyncPayload {
  /** Queue job id — used as the idempotency key prefix. */
  queueId: string;
  /** The user who owns the media. */
  ownerId: number;
  /** The Telegram file_id of the uploaded media. */
  mediaId: string;
  /** The Drive media record to create. */
  media: CreateMediaRequest;
  /** Optional folder to create/ensure and add the media to. */
  folder?: { id: string; name: string; parentId?: string };
}

export interface PostDownloadSyncPayload {
  queueId: string;
  ownerId: number;
  mediaId: string;
  /** When true, the media is added to the user's favorites. */
  favorite?: boolean;
}

export class DriveSyncService {
  constructor(
    private readonly client: DriveApiClient,
    private readonly metrics: MetricsCollector,
  ) {}

  /**
   * Run the post-upload sync asynchronously. Returns immediately; the
   * caller (the queue worker) does NOT await this. Errors are logged and
   * counted but never thrown.
   */
  syncAfterUpload(payload: PostUploadSyncPayload): void {
    void this.runUploadSync(payload).catch((error) => {
      logger.error({ queueId: payload.queueId, error: error instanceof Error ? error.message : String(error) }, 'drive sync upload unexpectedly threw');
    });
  }

  /**
   * Run the post-download sync asynchronously. Same fire-and-forget
   * contract as `syncAfterUpload`.
   */
  syncAfterDownload(payload: PostDownloadSyncPayload): void {
    void this.runDownloadSync(payload).catch((error) => {
      logger.error({ queueId: payload.queueId, error: error instanceof Error ? error.message : String(error) }, 'drive sync download unexpectedly threw');
    });
  }

  /**
   * Synchronous version used by tests and the `/drivehealth` probe. Not
   * exposed to the runtime flow.
   */
  async runUploadSync(payload: PostUploadSyncPayload): Promise<UploadSyncOutcome> {
    const log = loggerFor({ queueId: payload.queueId, ownerId: payload.ownerId });
    if (!this.client.configured) {
      log.debug('drive api not configured — skipping upload sync');
      return { status: 'skipped', reason: 'not-configured' };
    }

    const startedAt = Date.now();
    const key = (suffix: string) => `${payload.queueId}:${suffix}`;

    // Step 1: POST /media (required — failure here aborts the sync).
    const media = await this.withRetry(
      () => this.client.createMedia(payload.media, key('media')),
      key('media'),
      log,
    );
    if (!media.result.ok) {
      this.recordSyncFailure(startedAt, media.exhausted);
      return { status: 'failed', step: 'media', result: media.result };
    }
    log.info({ mediaId: payload.mediaId, status: media.result.status }, 'drive media created');

    // Step 2: folder (best-effort — failure here does not undo step 1).
    if (payload.folder) {
      const folderBody: CreateFolderRequest = {
        id: payload.folder.id,
        ownerId: payload.ownerId,
        name: payload.folder.name,
        parentId: payload.folder.parentId,
      };
      const folder = await this.withRetry(
        () => this.client.createFolder(folderBody, key('folder')),
        key('folder'),
        log,
      );
      if (folder.result.ok) {
        const add = await this.withRetry(
          () => this.client.addMediaToFolder(payload.folder!.id, { mediaId: payload.mediaId, ownerId: payload.ownerId }, key('folder-media')),
          key('folder-media'),
          log,
        );
        if (!add.result.ok) {
          log.warn({ folderId: payload.folder.id, status: add.result.status }, 'add media to folder failed (best-effort)');
        }
      } else {
        log.warn({ folderId: payload.folder.id, status: folder.result.status }, 'folder creation failed (best-effort)');
      }
    }

    // Step 3: POST /media/:id/sync (best-effort re-sync notification).
    const sync = await this.withRetry(
      () => this.client.syncMedia(payload.mediaId, {}, key('sync')),
      key('sync'),
      log,
    );
    if (!sync.result.ok) {
      log.warn({ mediaId: payload.mediaId, status: sync.result.status }, 'drive media sync notification failed (best-effort)');
    }

    this.recordSyncSuccess(startedAt);
    return { status: 'ok', mediaResult: media.result, syncResult: sync.result };
  }

  async runDownloadSync(payload: PostDownloadSyncPayload): Promise<DownloadSyncOutcome> {
    const log = loggerFor({ queueId: payload.queueId, ownerId: payload.ownerId });
    if (!this.client.configured) {
      log.debug('drive api not configured — skipping download sync');
      return { status: 'skipped', reason: 'not-configured' };
    }

    const startedAt = Date.now();
    const key = (suffix: string) => `${payload.queueId}:${suffix}`;

    // Step 1: POST /recent (required — failure here aborts the sync).
    const recentBody: RecentRequest = { mediaId: payload.mediaId, ownerId: payload.ownerId };
    const recent = await this.withRetry(
      () => this.client.recordRecent(recentBody, key('recent')),
      key('recent'),
      log,
    );
    if (!recent.result.ok) {
      this.recordSyncFailure(startedAt, recent.exhausted);
      return { status: 'failed', step: 'recent', result: recent.result };
    }
    log.info({ mediaId: payload.mediaId }, 'drive recent recorded');

    // Step 2: POST /favorites (only when favorite flag is set; best-effort).
    if (payload.favorite) {
      const favoriteBody: FavoriteRequest = { mediaId: payload.mediaId, ownerId: payload.ownerId };
      const favorite = await this.withRetry(
        () => this.client.addFavorite(favoriteBody, key('favorite')),
        key('favorite'),
        log,
      );
      if (!favorite.result.ok) {
        log.warn({ mediaId: payload.mediaId, status: favorite.result.status }, 'add favorite failed (best-effort)');
      }
    }

    this.recordSyncSuccess(startedAt);
    return { status: 'ok', recentResult: recent.result };
  }

  /**
   * Retry wrapper. Returns the last result plus a flag indicating whether
   * retries were exhausted (true only when a retryable failure ran out of
   * attempts). Permanent failures (401/403/422/404/409) return immediately
   * with `exhausted=false`. Retryable failures (429/5xx/network/timeout)
   * sleep with exponential backoff and retry up to
   * `DRIVE_SYNC_MAX_ATTEMPTS` times.
   */
  private async withRetry<T>(
    run: () => Promise<DriveCallResult<T>>,
    idempotencyKey: string,
    log: ReturnType<typeof loggerFor>,
  ): Promise<{ result: DriveCallResult<T>; exhausted: boolean }> {
    const maxAttempts = config.DRIVE_SYNC_MAX_ATTEMPTS;
    let lastResult: DriveCallResult<T> | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await run();
      lastResult = result;
      if (result.ok) {
        return { result, exhausted: false };
      }
      const decision = classifyDriveResult(result);
      log.warn({ attempt, maxAttempts, status: result.status, decision, idempotencyKey }, 'drive sync call failed');
      if (decision === 'permanent') {
        return { result, exhausted: false };
      }
      // Retryable failure: bump the retry counter for every attempt after
      // the first, regardless of whether the next attempt succeeds.
      if (attempt < maxAttempts) {
        await this.metrics.increment('drive_sync_retry');
        const delay = driveBackoffMs(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return { result: lastResult!, exhausted: true };
  }

  private recordSyncSuccess(startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    void this.metrics.increment('drive_sync_success');
    this.metrics.recordSync(durationMs, true);
    this.metrics.markSync();
  }

  private recordSyncFailure(startedAt: number, exhausted: boolean = false): void {
    const durationMs = Date.now() - startedAt;
    void this.metrics.increment('drive_sync_failed');
    if (exhausted) {
      void this.metrics.increment('drive_sync_dead');
    }
    this.metrics.recordSync(durationMs, false);
  }

  /**
   * Retry wrapper that also records per-service metrics. Used by every
   * Stage 4.1 service operation so the admin `/metrics` command can show
   * per-service success/failed/retry counters.
   *
   * Returns the last result plus a flag indicating whether retries were
   * exhausted (true only when a retryable failure ran out of attempts).
   */
  private async withRetryForService<T>(
    service: DriveServiceName,
    run: () => Promise<DriveCallResult<T>>,
    idempotencyKey: string,
    log: ReturnType<typeof loggerFor>,
  ): Promise<{ result: DriveCallResult<T>; exhausted: boolean; retries: number }> {
    const maxAttempts = config.DRIVE_SYNC_MAX_ATTEMPTS;
    let lastResult: DriveCallResult<T> | undefined;
    let retries = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await run();
      lastResult = result;
      if (result.ok) {
        await this.metrics.recordServiceOutcome(service, true, retries);
        return { result, exhausted: false, retries };
      }
      const decision = classifyDriveResult(result);
      log.warn({ service, attempt, maxAttempts, status: result.status, decision, idempotencyKey }, 'drive service call failed');
      if (decision === 'permanent') {
        await this.metrics.recordServiceOutcome(service, false, retries);
        return { result, exhausted: false, retries };
      }
      if (attempt < maxAttempts) {
        retries += 1;
        await this.metrics.increment('drive_sync_retry');
        const delay = driveBackoffMs(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    await this.metrics.recordServiceOutcome(service, false, retries);
    return { result: lastResult!, exhausted: true, retries };
  }

  // -------------------------------------------------------------------------
  // Stage 4.1 — full per-service operations.
  // Every method is asynchronous, retry-aware, and records per-service
  // metrics. Every mutating call carries an Idempotency-Key.
  // -------------------------------------------------------------------------

  /** Rename a folder. Async, retry, per-service metrics. */
  async renameFolder(folderId: string, body: RenameFolderRequest, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('folder', queueId, () =>
      this.client.renameFolder(folderId, body, `${queueId}:rename:${body.name}`),
    );
  }

  /** Move a folder to a new parent. */
  async moveFolder(folderId: string, body: MoveFolderRequest, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('folder', queueId, () =>
      this.client.moveFolder(folderId, body, `${queueId}:move:${body.parentId ?? 'root'}`),
    );
  }

  /** Delete a folder. */
  async deleteFolder(folderId: string, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('folder', queueId, () =>
      this.client.deleteFolder(folderId, `${queueId}:delete`),
    );
  }

  /** List folders for an owner. */
  async listFolders(ownerId: number, parentId: string | undefined, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('folder', queueId, () => this.client.listFolders(ownerId, parentId));
  }

  /** Update a share's expiry. */
  async updateShare(shareId: string, body: UpdateShareRequest, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('share', queueId, () => this.client.updateShare(shareId, body, `${queueId}:update`));
  }

  /** Revoke a share. */
  async revokeShare(shareId: string, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('share', queueId, () => this.client.revokeShare(shareId, `${queueId}:revoke`));
  }

  /** List shares for an owner. */
  async listShares(ownerId: number, mediaId: string | undefined, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('share', queueId, () => this.client.listShares(ownerId, mediaId));
  }

  /** Move a media record to the trash. */
  async moveToTrash(body: MoveToTrashRequest, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('trash', queueId, () =>
      this.client.moveToTrash(body, `${queueId}:trash:${body.mediaId}`),
    );
  }

  /** Restore a trashed item. */
  async restoreTrash(trashId: string, body: RestoreTrashRequest, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('trash', queueId, () =>
      this.client.restoreTrash(trashId, body, `${queueId}:restore`),
    );
  }

  /** List favorites for an owner. */
  async listFavorites(ownerId: number, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('favorite', queueId, () => this.client.listFavorites(ownerId));
  }

  /** Auto-cleanup recent entries for an owner. */
  async cleanupRecent(body: CleanupRecentRequest, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('recent', queueId, () =>
      this.client.cleanupRecent(body, `${queueId}:cleanup`),
    );
  }

  /** Update a collaborator's permission/role. */
  async updateCollaborator(inviteId: string, body: UpdateCollaboratorRequest, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('collaboration', queueId, () =>
      this.client.updateCollaborator(inviteId, body, `${queueId}:update`),
    );
  }

  /** Remove a collaborator. */
  async removeCollaborator(inviteId: string, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('collaboration', queueId, () =>
      this.client.removeCollaborator(inviteId, `${queueId}:remove`),
    );
  }

  /** List collaborators for a folder. */
  async listCollaborators(folderId: string, queueId: string): Promise<DriveCallResult<unknown>> {
    return this.runServiceOperation('collaboration', queueId, () => this.client.listCollaborators(folderId));
  }

  /**
   * Generic wrapper that runs a service operation through the retry+metrics
   * layer. The caller supplies the `DriveApiClient` call as a thunk so the
   * idempotency key is generated consistently. Returns the final result so
   * callers can inspect the status / body.
   */
  private async runServiceOperation<T>(
    service: DriveServiceName,
    queueId: string,
    run: () => Promise<DriveCallResult<T>>,
  ): Promise<DriveCallResult<unknown>> {
    const log = loggerFor({ queueId, service });
    if (!this.client.configured) {
      log.debug({ service }, 'drive api not configured — skipping service operation');
      return { status: 0, ok: false, body: null, text: 'not configured', durationMs: 0 };
    }
    const startedAt = Date.now();
    const { result, exhausted } = await this.withRetryForService(service, run, `${queueId}:${service}`, log);
    const durationMs = Date.now() - startedAt;
    this.metrics.recordSync(durationMs, result.ok);
    if (result.ok) {
      this.metrics.markSync();
    } else if (exhausted) {
      void this.metrics.increment('drive_sync_dead');
    }
    return result as DriveCallResult<unknown>;
  }
}

export interface UploadSyncOutcome {
  status: 'ok' | 'failed' | 'skipped';
  reason?: string;
  step?: string;
  mediaResult?: DriveCallResult<unknown>;
  syncResult?: DriveCallResult<unknown>;
  result?: DriveCallResult<unknown>;
}

export interface DownloadSyncOutcome {
  status: 'ok' | 'failed' | 'skipped';
  reason?: string;
  step?: string;
  recentResult?: DriveCallResult<unknown>;
  result?: DriveCallResult<unknown>;
}
