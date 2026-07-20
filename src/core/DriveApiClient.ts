import { config } from '../config/env';
import { logger } from '../logger/logger';
import {
  DRIVE_API_PREFIX,
  DriveHeaders,
  DriveStatus,
  CreateMediaRequest,
  CreateMediaResponse,
  HealthResponse,
  MediaRecord,
  SyncMediaRequest,
  SyncMediaResponse,
  VersionResponse,
  CreateFolderRequest,
  CreateFolderResponse,
  FolderRecord,
  AddMediaToFolderRequest,
  CreateShareRequest,
  CreateShareResponse,
  TrashRecord,
  FavoriteRequest,
  FavoriteResponse,
  RecentRequest,
  RecentResponse,
  CollaborationInviteRequest,
  CollaborationInviteResponse,
  // Stage 4.1
  RenameFolderRequest,
  RenameFolderResponse,
  MoveFolderRequest,
  MoveFolderResponse,
  ListFoldersResponse,
  UpdateShareRequest,
  UpdateShareResponse,
  ListSharesResponse,
  MoveToTrashRequest,
  MoveToTrashResponse,
  RestoreTrashRequest,
  RestoreTrashResponse,
  ListFavoritesResponse,
  CleanupRecentRequest,
  CleanupRecentResponse,
  UpdateCollaboratorRequest,
  UpdateCollaboratorResponse,
  ListCollaboratorsResponse,
} from './DriveBridgeContract';

export type { HealthResponse };

export interface DriveCallResult<T> {
  status: number;
  ok: boolean;
  body: T | null;
  /** Raw text body when JSON parsing failed or for error inspection. */
  text: string | null;
  /** Elapsed wall-clock time in ms. */
  durationMs: number;
}

/**
 * DriveApiClient is the SOLE client for every communication from the
 * Telegram Media Downloader to the Telegram Drive Bridge API. Stage 4.0
 * wires it into the post-upload and post-download flow so metadata, folders,
 * recent, and favorite records are synced through the official endpoints.
 *
 * Contract:
 *  - Auth: `X-API-Key: <DRIVE_API_KEY>` on every non-public endpoint.
 *  - Idempotency: `Idempotency-Key` on every POST/DELETE.
 *  - Versioning: every path is under `/api/v1/`.
 *  - The bot never sends the API key to logs (pino redact + sanitizeForLog).
 *
 * The client itself does NOT retry. Retry policy (401/403/422 permanent,
 * 429/5xx/network retry) is owned by the `DriveSyncService` so the queue
 * worker can apply backoff and dead-letter routing consistently.
 */
export class DriveApiClient {
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly clientName = 'telegram-media-downloader';

  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    this.baseUrl = opts?.baseUrl ?? config.DRIVE_API_BASE_URL;
    this.apiKey = opts?.apiKey ?? config.DRIVE_API_KEY;
    this.timeoutMs = opts?.timeoutMs ?? config.DRIVE_API_TIMEOUT_MS;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl) && Boolean(this.apiKey);
  }

  /** Probe the Drive Bridge health endpoint. */
  async health(): Promise<HealthResponse> {
    if (!this.baseUrl) {
      return { status: 'down', service: 'drive', checks: { configured: false } };
    }
    const result = await this.call<HealthResponse>('GET', '/integration/health', { authenticated: false });
    if (!result.ok || !result.body) {
      return {
        status: result.status >= 500 || result.status === 0 ? 'down' : 'degraded',
        service: 'drive',
        checks: { httpStatus: result.status, error: result.text ?? undefined },
      };
    }
    return result.body;
  }

  /** Fetch the Drive Bridge version + engine compatibility. */
  async getVersion(): Promise<DriveCallResult<VersionResponse>> {
    return await this.call<VersionResponse>('GET', '/integration/version', { authenticated: true });
  }

  /** Create or upsert a media record. Idempotent via the key header. */
  async createMedia(body: CreateMediaRequest, idempotencyKey?: string): Promise<DriveCallResult<CreateMediaResponse>> {
    return await this.call<CreateMediaResponse>('POST', '/media', {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? body.id,
      body,
    });
  }

  /** Fetch a single media record by id. */
  async getMedia(id: string): Promise<DriveCallResult<MediaRecord>> {
    return await this.call<MediaRecord>('GET', `/media/${encodeURIComponent(id)}`, { authenticated: true });
  }

  /** Delete a media record. Idempotent. */
  async deleteMedia(id: string, idempotencyKey?: string): Promise<DriveCallResult<null>> {
    return await this.call<null>('DELETE', `/media/${encodeURIComponent(id)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? id,
    });
  }

  /** Trigger a re-sync of a media record. */
  async syncMedia(id: string, body?: SyncMediaRequest, idempotencyKey?: string): Promise<DriveCallResult<SyncMediaResponse>> {
    return await this.call<SyncMediaResponse>('POST', `/media/${encodeURIComponent(id)}/sync`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? id,
      body: body ?? {},
    });
  }

  // -------------------------------------------------------------------------
  // Stage 4.0 — folder / share / trash / favorite / recent / collaboration
  // -------------------------------------------------------------------------

  /** Create or upsert a folder. Idempotent. */
  async createFolder(body: CreateFolderRequest, idempotencyKey?: string): Promise<DriveCallResult<CreateFolderResponse>> {
    return await this.call<CreateFolderResponse>('POST', '/folders', {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? body.id,
      body,
    });
  }

  /** Fetch a single folder by id. */
  async getFolder(id: string): Promise<DriveCallResult<FolderRecord>> {
    return await this.call<FolderRecord>('GET', `/folders/${encodeURIComponent(id)}`, { authenticated: true });
  }

  /** Add a media record to a folder. Idempotent. */
  async addMediaToFolder(folderId: string, body: AddMediaToFolderRequest, idempotencyKey?: string): Promise<DriveCallResult<null>> {
    return await this.call<null>('POST', `/folders/${encodeURIComponent(folderId)}/media`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${folderId}:${body.mediaId}`,
      body,
    });
  }

  /** Create a share link for a media record. Idempotent. */
  async createShare(mediaId: string, body: CreateShareRequest, idempotencyKey?: string): Promise<DriveCallResult<CreateShareResponse>> {
    return await this.call<CreateShareResponse>('POST', `/share/${encodeURIComponent(mediaId)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${mediaId}:${body.ownerId}`,
      body,
    });
  }

  /** List trashed items for an owner. */
  async listTrash(ownerId: number): Promise<DriveCallResult<TrashRecord[]>> {
    return await this.call<TrashRecord[]>('GET', `/trash?ownerId=${encodeURIComponent(ownerId)}`, { authenticated: true });
  }

  /** Restore or permanently delete a trashed item. Idempotent. */
  async deleteTrashItem(id: string, idempotencyKey?: string): Promise<DriveCallResult<null>> {
    return await this.call<null>('DELETE', `/trash/${encodeURIComponent(id)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? id,
    });
  }

  /** Mark a media record as favorite. Idempotent. */
  async addFavorite(body: FavoriteRequest, idempotencyKey?: string): Promise<DriveCallResult<FavoriteResponse>> {
    return await this.call<FavoriteResponse>('POST', '/favorites', {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${body.mediaId}:${body.ownerId}`,
      body,
    });
  }

  /** Remove a favorite. Idempotent. */
  async removeFavorite(id: string, idempotencyKey?: string): Promise<DriveCallResult<null>> {
    return await this.call<null>('DELETE', `/favorites/${encodeURIComponent(id)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? id,
    });
  }

  /** Record a media access for the recent list. Idempotent. */
  async recordRecent(body: RecentRequest, idempotencyKey?: string): Promise<DriveCallResult<RecentResponse>> {
    return await this.call<RecentResponse>('POST', '/recent', {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${body.mediaId}:${body.ownerId}`,
      body,
    });
  }

  /** Invite a collaborator to a folder. Idempotent. */
  async inviteCollaborator(folderId: string, body: CollaborationInviteRequest, idempotencyKey?: string): Promise<DriveCallResult<CollaborationInviteResponse>> {
    return await this.call<CollaborationInviteResponse>('POST', `/collaboration/${encodeURIComponent(folderId)}/invite`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${folderId}:${body.inviteeId}`,
      body,
    });
  }

  // -------------------------------------------------------------------------
  // Stage 4.1 — full folder / share / trash / favorite / recent /
  // collaboration operations (rename, move, delete, list, update, revoke,
  // restore, cleanup, permission update, remove, list collaborators).
  // All methods use the same `call` helper so auth, idempotency, timeouts,
  // and structured logging are uniform across the surface.
  // -------------------------------------------------------------------------

  /** Rename a folder. Idempotent. */
  async renameFolder(id: string, body: RenameFolderRequest, idempotencyKey?: string): Promise<DriveCallResult<RenameFolderResponse>> {
    return await this.call<RenameFolderResponse>('POST', `/folders/${encodeURIComponent(id)}/rename`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${id}:rename:${body.name}`,
      body,
    });
  }

  /** Move a folder to a new parent. Idempotent. */
  async moveFolder(id: string, body: MoveFolderRequest, idempotencyKey?: string): Promise<DriveCallResult<MoveFolderResponse>> {
    return await this.call<MoveFolderResponse>('POST', `/folders/${encodeURIComponent(id)}/move`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${id}:move:${body.parentId ?? 'root'}`,
      body,
    });
  }

  /** Delete a folder. Idempotent. */
  async deleteFolder(id: string, idempotencyKey?: string): Promise<DriveCallResult<null>> {
    return await this.call<null>('DELETE', `/folders/${encodeURIComponent(id)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${id}:delete`,
    });
  }

  /** List folders for an owner (optionally scoped to a parent). */
  async listFolders(ownerId: number, parentId?: string): Promise<DriveCallResult<ListFoldersResponse>> {
    const query = `?ownerId=${encodeURIComponent(ownerId)}${parentId ? `&parentId=${encodeURIComponent(parentId)}` : ''}`;
    return await this.call<ListFoldersResponse>('GET', `/folders${query}`, { authenticated: true });
  }

  /** Update a share's expiry. Idempotent. */
  async updateShare(shareId: string, body: UpdateShareRequest, idempotencyKey?: string): Promise<DriveCallResult<UpdateShareResponse>> {
    return await this.call<UpdateShareResponse>('POST', `/share/${encodeURIComponent(shareId)}/update`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${shareId}:update`,
      body,
    });
  }

  /** Revoke a share. Idempotent. */
  async revokeShare(shareId: string, idempotencyKey?: string): Promise<DriveCallResult<null>> {
    return await this.call<null>('DELETE', `/share/${encodeURIComponent(shareId)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${shareId}:revoke`,
    });
  }

  /** List shares for an owner (optionally filtered by mediaId). */
  async listShares(ownerId: number, mediaId?: string): Promise<DriveCallResult<ListSharesResponse>> {
    const query = `?ownerId=${encodeURIComponent(ownerId)}${mediaId ? `&mediaId=${encodeURIComponent(mediaId)}` : ''}`;
    return await this.call<ListSharesResponse>('GET', `/share/list${query}`, { authenticated: true });
  }

  /** Move a media record to the trash. Idempotent. */
  async moveToTrash(body: MoveToTrashRequest, idempotencyKey?: string): Promise<DriveCallResult<MoveToTrashResponse>> {
    return await this.call<MoveToTrashResponse>('POST', '/trash', {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${body.mediaId}:${body.ownerId}:trash`,
      body,
    });
  }

  /** Restore a trashed item. Idempotent. */
  async restoreTrash(trashId: string, body: RestoreTrashRequest, idempotencyKey?: string): Promise<DriveCallResult<RestoreTrashResponse>> {
    return await this.call<RestoreTrashResponse>('POST', `/trash/${encodeURIComponent(trashId)}/restore`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${trashId}:restore`,
      body,
    });
  }

  /** List favorites for an owner. */
  async listFavorites(ownerId: number): Promise<DriveCallResult<ListFavoritesResponse>> {
    return await this.call<ListFavoritesResponse>('GET', `/favorites?ownerId=${encodeURIComponent(ownerId)}`, { authenticated: true });
  }

  /** Auto-cleanup recent entries for an owner. Idempotent. */
  async cleanupRecent(body: CleanupRecentRequest, idempotencyKey?: string): Promise<DriveCallResult<CleanupRecentResponse>> {
    return await this.call<CleanupRecentResponse>('POST', '/recent/cleanup', {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${body.ownerId}:cleanup`,
      body,
    });
  }

  /** Update a collaborator's permission/role. Idempotent. */
  async updateCollaborator(inviteId: string, body: UpdateCollaboratorRequest, idempotencyKey?: string): Promise<DriveCallResult<UpdateCollaboratorResponse>> {
    return await this.call<UpdateCollaboratorResponse>('POST', `/collaboration/${encodeURIComponent(inviteId)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${inviteId}:update`,
      body,
    });
  }

  /** Remove a collaborator. Idempotent. */
  async removeCollaborator(inviteId: string, idempotencyKey?: string): Promise<DriveCallResult<null>> {
    return await this.call<null>('DELETE', `/collaboration/${encodeURIComponent(inviteId)}`, {
      authenticated: true,
      idempotencyKey: idempotencyKey ?? `${inviteId}:remove`,
    });
  }

  /** List collaborators for a folder. */
  async listCollaborators(folderId: string): Promise<DriveCallResult<ListCollaboratorsResponse>> {
    return await this.call<ListCollaboratorsResponse>('GET', `/collaboration/${encodeURIComponent(folderId)}`, { authenticated: true });
  }

  /**
   * Low-level call helper used by every public method. Returns the raw
   * status, parsed body (or null), text body, and duration so callers can
   * distinguish 401 from 403 from 429 from 500 without throwing.
   */
  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { authenticated: boolean; idempotencyKey?: string; body?: unknown },
  ): Promise<DriveCallResult<T>> {
    if (!this.baseUrl) {
      return { status: 0, ok: false, body: null, text: 'drive api not configured', durationMs: 0 };
    }
    const url = joinUrl(this.baseUrl, path.startsWith(DRIVE_API_PREFIX) ? path : `${DRIVE_API_PREFIX}${path}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    const headers: Record<string, string> = {
      [DriveHeaders.accept]: 'application/json',
      [DriveHeaders.apiVersion]: DRIVE_API_PREFIX,
      [DriveHeaders.client]: this.clientName,
    };
    if (opts.authenticated && this.apiKey) {
      headers[DriveHeaders.apiKey] = this.apiKey;
    }
    if (opts.idempotencyKey) {
      headers[DriveHeaders.idempotencyKey] = opts.idempotencyKey;
    }
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      bodyText = JSON.stringify(opts.body);
      headers[DriveHeaders.contentType] = 'application/json';
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
      });
      const durationMs = Date.now() - startedAt;
      const text = await safeText(response);
      const ok = response.status >= 200 && response.status < 300;
      const parsed = parseJson<T>(text);
      return { status: response.status, ok, body: parsed, text, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const aborted = error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(message));
      logger.warn(
        { url, method, error: message, aborted, durationMs },
        'drive api call failed',
      );
      return {
        status: aborted ? -1 : 0,
        ok: false,
        body: null,
        text: message,
        durationMs,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exposed for tests that need to know what status codes the contract uses. */
export { DriveStatus };

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function safeText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}
