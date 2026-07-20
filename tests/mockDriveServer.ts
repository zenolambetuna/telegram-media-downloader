import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  DriveEndpoints,
  DriveHeaders,
  DriveStatus,
  CreateMediaRequest,
  HealthResponse,
  MediaRecord,
  SyncMediaResponse,
  VersionResponse,
  CreateFolderRequest,
  FolderRecord,
  AddMediaToFolderRequest,
  CreateShareRequest,
  ShareRecord,
  TrashRecord,
  FavoriteRequest,
  FavoriteRecord,
  RecentRequest,
  RecentRecord,
  CollaborationInviteRequest,
  CollaborationInvite,
  // Stage 4.1
  RenameFolderRequest,
  MoveFolderRequest,
  UpdateShareRequest,
  MoveToTrashRequest,
  RestoreTrashRequest,
  CleanupRecentRequest,
  UpdateCollaboratorRequest,
} from '../src/core/DriveBridgeContract';

/**
 * MockDriveServer is a local HTTP server that implements the v1 Bridge
 * contract for the integration test suite. It uses only Node's built-in
 * `http` module — no new dependencies. Every endpoint can be put into a
 * specific failure mode via `setMode()` so the integration tests can
 * exercise success, timeout, 401/403/404/409/422/429/500, and network
 * failures without touching a real Drive instance.
 *
 * The mock keeps an in-memory `media` table and an idempotency cache so the
 * duplicate-request behaviour of the real Bridge is reproduced faithfully.
 *
 * Lifecycle:
 *   const server = new MockDriveServer();
 *   await server.start();
 *   const url = server.baseUrl;       // http://127.0.0.1:PORT
 *   server.setMode('createMedia', '409');
 *   ... assertions ...
 *   await server.stop();
 */

export type EndpointName =
  | 'health'
  | 'version'
  | 'createMedia'
  | 'getMedia'
  | 'deleteMedia'
  | 'syncMedia'
  | 'createFolder'
  | 'getFolder'
  | 'addMediaToFolder'
  | 'createShare'
  | 'listTrash'
  | 'deleteTrashItem'
  | 'addFavorite'
  | 'removeFavorite'
  | 'recordRecent'
  | 'inviteCollaborator'
  // Stage 4.1
  | 'renameFolder'
  | 'moveFolder'
  | 'deleteFolder'
  | 'listFolders'
  | 'updateShare'
  | 'revokeShare'
  | 'listShares'
  | 'moveToTrash'
  | 'restoreTrash'
  | 'listFavorites'
  | 'cleanupRecent'
  | 'updateCollaborator'
  | 'removeCollaborator'
  | 'listCollaborators';

export type FailureMode =
  | 'success'
  | 'timeout'
  | '401'
  | '403'
  | '404'
  | '409'
  | '422'
  | '429'
  | '500'
  | 'network';

export type RequestLogEntry = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  receivedAt: string;
};

const VALID_API_KEY = 'test-api-key';

export class MockDriveServer {
  private server: http.Server | undefined;
  private port = 0;
  private readonly modes = new Map<EndpointName, FailureMode>();
  private readonly media = new Map<string, MediaRecord>();
  private readonly idempotency = new Map<string, { status: number; body: unknown }>();
  private readonly requestLog: RequestLogEntry[] = [];
  /** Optional delay injected before a response is sent (ms). */
  private delayMs = 0;
  // Stage 4.0 in-memory stores.
  private readonly folders = new Map<string, FolderRecord>();
  private readonly folderMedia = new Map<string, Set<string>>();
  private readonly shares = new Map<string, ShareRecord>();
  private readonly trash = new Map<string, TrashRecord>();
  private readonly favorites = new Map<string, FavoriteRecord>();
  private readonly recents = new Map<string, RecentRecord>();
  private readonly collaborations = new Map<string, CollaborationInvite>();

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { code: 'MOCK_FAILURE', message: String(error) } }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server?.address() as AddressInfo | undefined;
    this.port = address?.port ?? 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = undefined;
  }

  setMode(endpoint: EndpointName, mode: FailureMode): void {
    this.modes.set(endpoint, mode);
  }

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  reset(): void {
    this.modes.clear();
    this.media.clear();
    this.idempotency.clear();
    this.requestLog.length = 0;
    this.delayMs = 0;
    this.folders.clear();
    this.folderMedia.clear();
    this.shares.clear();
    this.trash.clear();
    this.favorites.clear();
    this.recents.clear();
    this.collaborations.clear();
  }

  getRequests(): RequestLogEntry[] {
    return [...this.requestLog];
  }

  /** Read-only access to the in-memory media table for assertions. */
  mediaStore(): Map<string, MediaRecord> {
    return new Map(this.media);
  }

  folderStore(): Map<string, FolderRecord> {
    return new Map(this.folders);
  }

  favoriteStore(): Map<string, FavoriteRecord> {
    return new Map(this.favorites);
  }

  recentStore(): Map<string, RecentRecord> {
    return new Map(this.recents);
  }

  shareStore(): Map<string, ShareRecord> {
    return new Map(this.shares);
  }

  trashStore(): Map<string, TrashRecord> {
    return new Map(this.trash);
  }

  collaborationStore(): Map<string, CollaborationInvite> {
    return new Map(this.collaborations);
  }

  private mode(endpoint: EndpointName): FailureMode {
    return this.modes.get(endpoint) ?? 'success';
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname;
    const query = url.searchParams;
    const method = req.method ?? 'GET';

    const bodyText = await readBody(req);
    const body = bodyText ? safeParse(bodyText) : undefined;
    const headers = lowercaseHeaders(req.headers);

    // Auth check for every endpoint except /integration/health.
    const endpoint = this.identify(method, path);
    if (endpoint && endpoint !== 'health') {
      const auth = headers[DriveHeaders.apiKey.toLowerCase()];
      if (auth !== VALID_API_KEY) {
        this.recordRequest(method, path, headers, body, DriveStatus.notAuthenticated);
        return this.respond(res, endpoint, DriveStatus.notAuthenticated, errorBody('UNAUTHENTICATED', 'Missing or invalid API key'));
      }
    }

    const mode = endpoint ? this.mode(endpoint) : 'success';
    if (mode === 'timeout') {
      // Don't respond. The client's AbortController will fire. We record
      // the request so tests can assert the call was attempted.
      this.recordRequest(method, path, headers, body, 0);
      return;
    }
    if (mode === 'network') {
      this.recordRequest(method, path, headers, body, 0);
      // Destroy the socket so the client sees ECONNRESET.
      res.destroy();
      return;
    }

    // Apply artificial delay for slow-response tests.
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    switch (endpoint) {
      case 'health':
        return this.handleHealth(method, headers, body, res, path);
      case 'version':
        return this.handleVersion(method, headers, body, res, path);
      case 'createMedia':
        return this.handleCreate(method, headers, body, res, path);
      case 'getMedia':
        return this.handleGet(method, headers, body, res, path);
      case 'deleteMedia':
        return this.handleDelete(method, headers, body, res, path);
      case 'syncMedia':
        return this.handleSync(method, headers, body, res, path);
      case 'createFolder':
        return this.handleCreateFolder(method, headers, body, res, path);
      case 'getFolder':
        return this.handleGetFolder(method, headers, body, res, path);
      case 'addMediaToFolder':
        return this.handleAddMediaToFolder(method, headers, body, res, path);
      case 'createShare':
        return this.handleCreateShare(method, headers, body, res, path);
      case 'listTrash':
        return this.handleListTrash(method, headers, body, res, path, query);
      case 'deleteTrashItem':
        return this.handleDeleteTrashItem(method, headers, body, res, path);
      case 'addFavorite':
        return this.handleAddFavorite(method, headers, body, res, path);
      case 'removeFavorite':
        return this.handleRemoveFavorite(method, headers, body, res, path);
      case 'recordRecent':
        return this.handleRecordRecent(method, headers, body, res, path);
      case 'inviteCollaborator':
        return this.handleInviteCollaborator(method, headers, body, res, path);
      // Stage 4.1
      case 'renameFolder':
        return this.handleRenameFolder(method, headers, body, res, path);
      case 'moveFolder':
        return this.handleMoveFolder(method, headers, body, res, path);
      case 'deleteFolder':
        return this.handleDeleteFolder(method, headers, body, res, path);
      case 'listFolders':
        return this.handleListFolders(method, headers, body, res, path, query);
      case 'updateShare':
        return this.handleUpdateShare(method, headers, body, res, path);
      case 'revokeShare':
        return this.handleRevokeShare(method, headers, body, res, path);
      case 'listShares':
        return this.handleListShares(method, headers, body, res, path, query);
      case 'moveToTrash':
        return this.handleMoveToTrash(method, headers, body, res, path);
      case 'restoreTrash':
        return this.handleRestoreTrash(method, headers, body, res, path);
      case 'listFavorites':
        return this.handleListFavorites(method, headers, body, res, path, query);
      case 'cleanupRecent':
        return this.handleCleanupRecent(method, headers, body, res, path);
      case 'updateCollaborator':
        return this.handleUpdateCollaborator(method, headers, body, res, path);
      case 'removeCollaborator':
        return this.handleRemoveCollaborator(method, headers, body, res, path);
      case 'listCollaborators':
        return this.handleListCollaborators(method, headers, body, res, path);
      default:
        this.recordRequest(method, path, headers, body, DriveStatus.notFound);
        return this.respond(res, null, DriveStatus.notFound, errorBody('ROUTE_NOT_FOUND', `Unknown route: ${method} ${path}`));
    }
  }

  private identify(method: string, path: string): EndpointName | null {
    if (path === DriveEndpoints.health && method === 'GET') return 'health';
    if (path === DriveEndpoints.version && method === 'GET') return 'version';
    if (path === DriveEndpoints.createMedia && method === 'POST') return 'createMedia';
    if (/^\/api\/v1\/media\/[^/]+\/sync$/.test(path) && method === 'POST') return 'syncMedia';
    if (/^\/api\/v1\/media\/[^/]+$/.test(path) && method === 'GET') return 'getMedia';
    if (/^\/api\/v1\/media\/[^/]+$/.test(path) && method === 'DELETE') return 'deleteMedia';
    // Stage 4.0 + 4.1 — folders. Order: specific first.
    if (path === DriveEndpoints.folders && method === 'POST') return 'createFolder';
    if (path === DriveEndpoints.folders && method === 'GET') return 'listFolders';
    if (/^\/api\/v1\/folders\/[^/]+\/media$/.test(path) && method === 'POST') return 'addMediaToFolder';
    if (/^\/api\/v1\/folders\/[^/]+\/move$/.test(path) && method === 'POST') return 'moveFolder';
    if (/^\/api\/v1\/folders\/[^/]+\/rename$/.test(path) && method === 'POST') return 'renameFolder';
    if (/^\/api\/v1\/folders\/[^/]+$/.test(path) && method === 'GET') return 'getFolder';
    if (/^\/api\/v1\/folders\/[^/]+$/.test(path) && method === 'DELETE') return 'deleteFolder';
    // Stage 4.0 + 4.1 — share. `list` and `update` before generic `:id`.
    if (/^\/api\/v1\/share\/list$/.test(path) && method === 'GET') return 'listShares';
    if (/^\/api\/v1\/share\/[^/]+\/update$/.test(path) && method === 'POST') return 'updateShare';
    if (/^\/api\/v1\/share\/[^/]+$/.test(path) && method === 'POST') return 'createShare';
    if (/^\/api\/v1\/share\/[^/]+$/.test(path) && method === 'DELETE') return 'revokeShare';
    // Stage 4.0 + 4.1 — trash. `restore` before generic `:id`.
    if (path === DriveEndpoints.trash && method === 'POST') return 'moveToTrash';
    if (path === DriveEndpoints.trash && method === 'GET') return 'listTrash';
    if (/^\/api\/v1\/trash\/[^/]+\/restore$/.test(path) && method === 'POST') return 'restoreTrash';
    if (/^\/api\/v1\/trash\/[^/]+$/.test(path) && method === 'DELETE') return 'deleteTrashItem';
    // Stage 4.0 + 4.1 — favorites.
    if (path === DriveEndpoints.favorite && method === 'POST') return 'addFavorite';
    if (path === DriveEndpoints.favorite && method === 'GET') return 'listFavorites';
    if (/^\/api\/v1\/favorites\/[^/]+$/.test(path) && method === 'DELETE') return 'removeFavorite';
    // Stage 4.0 + 4.1 — recent.
    if (path === DriveEndpoints.recent && method === 'POST') return 'recordRecent';
    if (path === DriveEndpoints.recentCleanup && method === 'POST') return 'cleanupRecent';
    // Stage 4.0 + 4.1 — collaboration. `invite` before generic `:id`.
    if (/^\/api\/v1\/collaboration\/[^/]+\/invite$/.test(path) && method === 'POST') return 'inviteCollaborator';
    if (/^\/api\/v1\/collaboration\/[^/]+$/.test(path) && method === 'POST') return 'updateCollaborator';
    if (/^\/api\/v1\/collaboration\/[^/]+$/.test(path) && method === 'DELETE') return 'removeCollaborator';
    if (/^\/api\/v1\/collaboration\/[^/]+$/.test(path) && method === 'GET') return 'listCollaborators';
    return null;
  }

  private handleHealth(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('health');
    if (mode === '500') {
      this.recordRequest(method, path, headers, body, DriveStatus.internalError);
      return this.respond(res, 'health', DriveStatus.internalError, errorBody('INTERNAL', 'mock injected 500'));
    }
    const payload: HealthResponse = {
      status: 'ok',
      service: 'drive',
      version: '3.2.1',
      timestamp: new Date().toISOString(),
      checks: { database: 'ok', storage: 'ok' },
    };
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'health', DriveStatus.ok, payload);
  }

  private handleVersion(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('version');
    if (mode === '500') {
      this.recordRequest(method, path, headers, body, DriveStatus.internalError);
      return this.respond(res, 'version', DriveStatus.internalError, errorBody('INTERNAL', 'mock injected 500'));
    }
    if (mode === '401') {
      this.recordRequest(method, path, headers, body, DriveStatus.notAuthenticated);
      return this.respond(res, 'version', DriveStatus.notAuthenticated, errorBody('UNAUTHENTICATED', 'mock injected 401'));
    }
    const payload: VersionResponse = {
      service: 'drive',
      version: '3.2.1',
      apiVersion: 'v1',
      engineCompatibility: '^3.0.0',
      build: 'mock-2026.07',
    };
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'version', DriveStatus.ok, payload);
  }

  private handleCreate(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('createMedia');
    if (mode === '401') {
      this.recordRequest(method, path, headers, body, DriveStatus.notAuthenticated);
      return this.respond(res, 'createMedia', DriveStatus.notAuthenticated, errorBody('UNAUTHENTICATED', 'mock injected 401'));
    }
    if (mode === '403') {
      this.recordRequest(method, path, headers, body, DriveStatus.forbidden);
      return this.respond(res, 'createMedia', DriveStatus.forbidden, errorBody('FORBIDDEN', 'mock injected 403'));
    }
    if (mode === '409') {
      this.recordRequest(method, path, headers, body, DriveStatus.conflict);
      return this.respond(res, 'createMedia', DriveStatus.conflict, conflictBody('A media with this checksum already exists for another id'));
    }
    if (mode === '422') {
      this.recordRequest(method, path, headers, body, DriveStatus.unprocessable);
      return this.respond(res, 'createMedia', DriveStatus.unprocessable, validationErrorBody('ownerId', 'must be a positive integer'));
    }
    if (mode === '429') {
      this.recordRequest(method, path, headers, body, DriveStatus.rateLimited);
      return this.respond(res, 'createMedia', DriveStatus.rateLimited, rateLimitedBody(5));
    }
    if (mode === '500') {
      this.recordRequest(method, path, headers, body, DriveStatus.internalError);
      return this.respond(res, 'createMedia', DriveStatus.internalError, errorBody('INTERNAL', 'mock injected 500'));
    }

    // Default success path: validate schema, dedupe by Idempotency-Key, store.
    const record = body as Partial<CreateMediaRequest> | undefined;
    if (!record || !isCreateMediaRequest(record)) {
      this.recordRequest(method, path, headers, body, DriveStatus.unprocessable);
      return this.respond(res, 'createMedia', DriveStatus.unprocessable, validationErrorBody('payload', 'CreateMediaRequest schema mismatch'));
    }

    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey) {
      const cached = this.idempotency.get(idempotencyKey);
      if (cached) {
        this.recordRequest(method, path, headers, body, cached.status);
        return this.respond(res, 'createMedia', cached.status, cached.body);
      }
    }

    const stored: MediaRecord = {
      id: record.id,
      ownerId: record.ownerId,
      provider: record.provider,
      canonicalUrl: record.canonicalUrl,
      originalUrl: record.originalUrl,
      title: record.title,
      description: record.description,
      duration: record.duration,
      thumbnail: record.thumbnail,
      mimeType: record.mimeType,
      quality: record.quality,
      resolution: record.resolution,
      size: record.size,
      checksum: record.checksum,
      fileId: record.fileId,
      messageId: record.messageId,
      chatId: record.chatId,
      uploadDate: new Date().toISOString(),
    };
    this.media.set(stored.id, stored);
    const status = this.media.has(stored.id) && record.id === stored.id ? DriveStatus.created : DriveStatus.created;
    const response = { ...stored };
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status, body: response });
    }
    this.recordRequest(method, path, headers, body, status);
    return this.respond(res, 'createMedia', status, response);
  }

  private handleGet(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('getMedia');
    if (mode === '401') {
      this.recordRequest(method, path, headers, body, DriveStatus.notAuthenticated);
      return this.respond(res, 'getMedia', DriveStatus.notAuthenticated, errorBody('UNAUTHENTICATED', 'mock injected 401'));
    }
    if (mode === '403') {
      this.recordRequest(method, path, headers, body, DriveStatus.forbidden);
      return this.respond(res, 'getMedia', DriveStatus.forbidden, errorBody('FORBIDDEN', 'mock injected 403'));
    }
    if (mode === '404' || !this.media.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'getMedia', DriveStatus.notFound, errorBody('MEDIA_NOT_FOUND', `No media with id ${id}`));
    }
    if (mode === '500') {
      this.recordRequest(method, path, headers, body, DriveStatus.internalError);
      return this.respond(res, 'getMedia', DriveStatus.internalError, errorBody('INTERNAL', 'mock injected 500'));
    }
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'getMedia', DriveStatus.ok, this.media.get(id));
  }

  private handleDelete(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('deleteMedia');
    if (mode === '401') {
      this.recordRequest(method, path, headers, body, DriveStatus.notAuthenticated);
      return this.respond(res, 'deleteMedia', DriveStatus.notAuthenticated, errorBody('UNAUTHENTICATED', 'mock injected 401'));
    }
    if (mode === '403') {
      this.recordRequest(method, path, headers, body, DriveStatus.forbidden);
      return this.respond(res, 'deleteMedia', DriveStatus.forbidden, errorBody('FORBIDDEN', 'mock injected 403'));
    }
    if (mode === '500') {
      this.recordRequest(method, path, headers, body, DriveStatus.internalError);
      return this.respond(res, 'deleteMedia', DriveStatus.internalError, errorBody('INTERNAL', 'mock injected 500'));
    }
    // Idempotency check comes BEFORE the 404 check: a replayed delete must
    // return the cached 204 even though the media is now gone.
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'deleteMedia', cached.status, cached.body);
    }
    if (mode === '404' || !this.media.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'deleteMedia', DriveStatus.notFound, errorBody('MEDIA_NOT_FOUND', `No media with id ${id}`));
    }
    if (mode === '409') {
      this.recordRequest(method, path, headers, body, DriveStatus.conflict);
      return this.respond(res, 'deleteMedia', DriveStatus.conflict, conflictBody('Media is referenced by an active sync'));
    }
    this.media.delete(id);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.noContent, body: null });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.noContent);
    return this.respond(res, 'deleteMedia', DriveStatus.noContent, null);
  }

  private handleSync(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/')[4] ?? '';
    const mode = this.mode('syncMedia');
    if (mode === '401') {
      this.recordRequest(method, path, headers, body, DriveStatus.notAuthenticated);
      return this.respond(res, 'syncMedia', DriveStatus.notAuthenticated, errorBody('UNAUTHENTICATED', 'mock injected 401'));
    }
    if (mode === '403') {
      this.recordRequest(method, path, headers, body, DriveStatus.forbidden);
      return this.respond(res, 'syncMedia', DriveStatus.forbidden, errorBody('FORBIDDEN', 'mock injected 403'));
    }
    if (mode === '404' || !this.media.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'syncMedia', DriveStatus.notFound, errorBody('MEDIA_NOT_FOUND', `No media with id ${id}`));
    }
    if (mode === '409') {
      this.recordRequest(method, path, headers, body, DriveStatus.conflict);
      return this.respond(res, 'syncMedia', DriveStatus.conflict, conflictBody('A sync is already in flight for this id'));
    }
    if (mode === '429') {
      this.recordRequest(method, path, headers, body, DriveStatus.rateLimited);
      return this.respond(res, 'syncMedia', DriveStatus.rateLimited, rateLimitedBody(10));
    }
    if (mode === '500') {
      this.recordRequest(method, path, headers, body, DriveStatus.internalError);
      return this.respond(res, 'syncMedia', DriveStatus.internalError, errorBody('INTERNAL', 'mock injected 500'));
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'syncMedia', cached.status, cached.body);
    }
    const payload: SyncMediaResponse = { id, status: 'queued', syncId: randomUUID() };
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.accepted, body: payload });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.accepted);
    return this.respond(res, 'syncMedia', DriveStatus.accepted, payload);
  }

  // -------------------------------------------------------------------------
  // Stage 4.0 endpoint handlers
  // -------------------------------------------------------------------------

  private handleCreateFolder(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('createFolder');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'createFolder');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'createFolder');
    if (mode === '409') return this.failConflict(res, method, path, headers, body, 'createFolder', 'Folder already exists');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'createFolder', 'name', 'must be a non-empty string');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'createFolder', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'createFolder');
    if (mode === 'timeout') return this.hang(method, path, headers, body);
    if (mode === 'network') return this.destroy(method, path, headers, body, res);

    const request = body as Partial<CreateFolderRequest> | undefined;
    if (!request || typeof request.id !== 'string' || typeof request.ownerId !== 'number' || typeof request.name !== 'string') {
      return this.failValidation(res, method, path, headers, body, 'createFolder', 'payload', 'CreateFolderRequest schema mismatch');
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'createFolder', cached.status, cached.body);
    }
    const now = new Date().toISOString();
    const folder: FolderRecord = {
      id: request.id,
      ownerId: request.ownerId,
      name: request.name,
      parentId: request.parentId,
      createdAt: now,
      updatedAt: now,
    };
    this.folders.set(folder.id, folder);
    if (!this.folderMedia.has(folder.id)) {
      this.folderMedia.set(folder.id, new Set());
    }
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.created, body: folder });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.created);
    return this.respond(res, 'createFolder', DriveStatus.created, folder);
  }

  private handleGetFolder(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('getFolder');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'getFolder');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'getFolder');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'getFolder');
    if (mode === '404' || !this.folders.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'getFolder', DriveStatus.notFound, errorBody('FOLDER_NOT_FOUND', `No folder with id ${id}`));
    }
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'getFolder', DriveStatus.ok, this.folders.get(id));
  }

  private handleAddMediaToFolder(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const folderId = path.split('/')[4] ?? '';
    const mode = this.mode('addMediaToFolder');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'addMediaToFolder');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'addMediaToFolder');
    if (mode === '409') return this.failConflict(res, method, path, headers, body, 'addMediaToFolder', 'Media already in folder');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'addMediaToFolder', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'addMediaToFolder');
    if (mode === '404' || !this.folders.has(folderId)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'addMediaToFolder', DriveStatus.notFound, errorBody('FOLDER_NOT_FOUND', `No folder with id ${folderId}`));
    }
    const request = body as Partial<AddMediaToFolderRequest> | undefined;
    if (!request || typeof request.mediaId !== 'string' || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'addMediaToFolder', 'payload', 'AddMediaToFolderRequest schema mismatch');
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'addMediaToFolder', cached.status, cached.body);
    }
    const set = this.folderMedia.get(folderId) ?? new Set<string>();
    set.add(request.mediaId);
    this.folderMedia.set(folderId, set);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.created, body: null });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.created);
    return this.respond(res, 'addMediaToFolder', DriveStatus.created, null);
  }

  private handleCreateShare(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mediaId = path.split('/').pop() ?? '';
    const mode = this.mode('createShare');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'createShare');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'createShare');
    if (mode === '409') return this.failConflict(res, method, path, headers, body, 'createShare', 'Share already exists');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'createShare', 'mediaId', 'must be a non-empty string');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'createShare', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'createShare');
    if (mode === '404' || !this.media.has(mediaId)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'createShare', DriveStatus.notFound, errorBody('MEDIA_NOT_FOUND', `No media with id ${mediaId}`));
    }
    const request = body as Partial<CreateShareRequest> | undefined;
    if (!request || typeof request.mediaId !== 'string' || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'createShare', 'payload', 'CreateShareRequest schema mismatch');
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'createShare', cached.status, cached.body);
    }
    const share: ShareRecord = {
      id: randomUUID(),
      mediaId: request.mediaId,
      ownerId: request.ownerId,
      token: randomUUID().replace(/-/g, ''),
      expiresAt: request.expiresAt,
      createdAt: new Date().toISOString(),
    };
    this.shares.set(share.id, share);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.created, body: share });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.created);
    return this.respond(res, 'createShare', DriveStatus.created, share);
  }

  private handleListTrash(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string, query: URLSearchParams): void {
    const mode = this.mode('listTrash');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'listTrash');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'listTrash');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'listTrash');
    const ownerId = Number(query.get('ownerId') ?? '0');
    const items = [...this.trash.values()].filter((t) => ownerId === 0 || t.ownerId === ownerId);
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'listTrash', DriveStatus.ok, items);
  }

  private handleDeleteTrashItem(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('deleteTrashItem');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'deleteTrashItem');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'deleteTrashItem');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'deleteTrashItem');
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'deleteTrashItem', cached.status, cached.body);
    }
    if (mode === '404' || !this.trash.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'deleteTrashItem', DriveStatus.notFound, errorBody('TRASH_NOT_FOUND', `No trash item with id ${id}`));
    }
    this.trash.delete(id);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.noContent, body: null });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.noContent);
    return this.respond(res, 'deleteTrashItem', DriveStatus.noContent, null);
  }

  private handleAddFavorite(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('addFavorite');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'addFavorite');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'addFavorite');
    if (mode === '409') return this.failConflict(res, method, path, headers, body, 'addFavorite', 'Already favorited');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'addFavorite', 'mediaId', 'must be a non-empty string');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'addFavorite', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'addFavorite');
    const request = body as Partial<FavoriteRequest> | undefined;
    if (!request || typeof request.mediaId !== 'string' || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'addFavorite', 'payload', 'FavoriteRequest schema mismatch');
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'addFavorite', cached.status, cached.body);
    }
    // Idempotent: if (mediaId, ownerId) is already favorited, return the existing record.
    const existing = [...this.favorites.values()].find((f) => f.mediaId === request.mediaId && f.ownerId === request.ownerId);
    if (existing) {
      this.recordRequest(method, path, headers, body, DriveStatus.ok);
      return this.respond(res, 'addFavorite', DriveStatus.ok, existing);
    }
    const favorite: FavoriteRecord = {
      id: randomUUID(),
      mediaId: request.mediaId,
      ownerId: request.ownerId,
      createdAt: new Date().toISOString(),
    };
    this.favorites.set(favorite.id, favorite);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.created, body: favorite });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.created);
    return this.respond(res, 'addFavorite', DriveStatus.created, favorite);
  }

  private handleRemoveFavorite(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('removeFavorite');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'removeFavorite');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'removeFavorite');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'removeFavorite');
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'removeFavorite', cached.status, cached.body);
    }
    if (mode === '404' || !this.favorites.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'removeFavorite', DriveStatus.notFound, errorBody('FAVORITE_NOT_FOUND', `No favorite with id ${id}`));
    }
    this.favorites.delete(id);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.noContent, body: null });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.noContent);
    return this.respond(res, 'removeFavorite', DriveStatus.noContent, null);
  }

  private handleRecordRecent(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('recordRecent');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'recordRecent');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'recordRecent');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'recordRecent', 'mediaId', 'must be a non-empty string');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'recordRecent', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'recordRecent');
    const request = body as Partial<RecentRequest> | undefined;
    if (!request || typeof request.mediaId !== 'string' || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'recordRecent', 'payload', 'RecentRequest schema mismatch');
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'recordRecent', cached.status, cached.body);
    }
    // Upsert by (mediaId, ownerId): bump the accessedAt timestamp.
    const existing = [...this.recents.values()].find((r) => r.mediaId === request.mediaId && r.ownerId === request.ownerId);
    const now = new Date().toISOString();
    let record: RecentRecord;
    if (existing) {
      existing.accessedAt = now;
      record = existing;
    } else {
      record = { id: randomUUID(), mediaId: request.mediaId, ownerId: request.ownerId, accessedAt: now };
      this.recents.set(record.id, record);
    }
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.ok, body: record });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'recordRecent', DriveStatus.ok, record);
  }

  private handleInviteCollaborator(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const folderId = path.split('/')[4] ?? '';
    const mode = this.mode('inviteCollaborator');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'inviteCollaborator');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'inviteCollaborator');
    if (mode === '409') return this.failConflict(res, method, path, headers, body, 'inviteCollaborator', 'Invite already pending');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'inviteCollaborator', 'role', 'must be viewer/editor/owner');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'inviteCollaborator', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'inviteCollaborator');
    if (mode === '404' || !this.folders.has(folderId)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'inviteCollaborator', DriveStatus.notFound, errorBody('FOLDER_NOT_FOUND', `No folder with id ${folderId}`));
    }
    const request = body as Partial<CollaborationInviteRequest> | undefined;
    if (!request || typeof request.folderId !== 'string' || typeof request.inviterId !== 'number' || typeof request.inviteeId !== 'number' || typeof request.role !== 'string') {
      return this.failValidation(res, method, path, headers, body, 'inviteCollaborator', 'payload', 'CollaborationInviteRequest schema mismatch');
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'inviteCollaborator', cached.status, cached.body);
    }
    const invite: CollaborationInvite = {
      id: randomUUID(),
      folderId: request.folderId,
      inviterId: request.inviterId,
      inviteeId: request.inviteeId,
      role: request.role as CollaborationInvite['role'],
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.collaborations.set(invite.id, invite);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { status: DriveStatus.created, body: invite });
    }
    this.recordRequest(method, path, headers, body, DriveStatus.created);
    return this.respond(res, 'inviteCollaborator', DriveStatus.created, invite);
  }

  // -------------------------------------------------------------------------
  // Stage 4.1 endpoint handlers
  // -------------------------------------------------------------------------

  private handleRenameFolder(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/')[4] ?? '';
    const mode = this.mode('renameFolder');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'renameFolder');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'renameFolder');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'renameFolder', 'name', 'must be a non-empty string');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'renameFolder', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'renameFolder');
    if (mode === '404' || !this.folders.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'renameFolder', DriveStatus.notFound, errorBody('FOLDER_NOT_FOUND', `No folder with id ${id}`));
    }
    const request = body as Partial<RenameFolderRequest> | undefined;
    if (!request || typeof request.name !== 'string' || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'renameFolder', 'payload', 'RenameFolderRequest schema mismatch');
    }
    const folder = this.folders.get(id)!;
    folder.name = request.name;
    folder.updatedAt = new Date().toISOString();
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'renameFolder', DriveStatus.ok, folder);
  }

  private handleMoveFolder(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/')[4] ?? '';
    const mode = this.mode('moveFolder');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'moveFolder');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'moveFolder');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'moveFolder', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'moveFolder');
    if (mode === '404' || !this.folders.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'moveFolder', DriveStatus.notFound, errorBody('FOLDER_NOT_FOUND', `No folder with id ${id}`));
    }
    const request = body as Partial<MoveFolderRequest> | undefined;
    if (!request || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'moveFolder', 'payload', 'MoveFolderRequest schema mismatch');
    }
    const folder = this.folders.get(id)!;
    folder.parentId = request.parentId;
    folder.updatedAt = new Date().toISOString();
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'moveFolder', DriveStatus.ok, folder);
  }

  private handleDeleteFolder(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('deleteFolder');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'deleteFolder');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'deleteFolder');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'deleteFolder');
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'deleteFolder', cached.status, cached.body);
    }
    if (mode === '404' || !this.folders.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'deleteFolder', DriveStatus.notFound, errorBody('FOLDER_NOT_FOUND', `No folder with id ${id}`));
    }
    this.folders.delete(id);
    this.folderMedia.delete(id);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, { status: DriveStatus.noContent, body: null });
    this.recordRequest(method, path, headers, body, DriveStatus.noContent);
    return this.respond(res, 'deleteFolder', DriveStatus.noContent, null);
  }

  private handleListFolders(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string, query: URLSearchParams): void {
    const mode = this.mode('listFolders');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'listFolders');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'listFolders');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'listFolders');
    const ownerId = Number(query.get('ownerId') ?? '0');
    const parentId = query.get('parentId') ?? undefined;
    const items = [...this.folders.values()].filter((f) => ownerId === 0 || f.ownerId === ownerId);
    const filtered = parentId ? items.filter((f) => f.parentId === parentId) : items;
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'listFolders', DriveStatus.ok, filtered);
  }

  private handleUpdateShare(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    // Path is /api/v1/share/:id/update — extract the id (segment before "update").
    const parts = path.split('/');
    const id = parts[4] ?? '';
    const mode = this.mode('updateShare');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'updateShare');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'updateShare');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'updateShare', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'updateShare');
    if (mode === '404' || !this.shares.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'updateShare', DriveStatus.notFound, errorBody('SHARE_NOT_FOUND', `No share with id ${id}`));
    }
    const request = body as Partial<UpdateShareRequest> | undefined;
    if (!request || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'updateShare', 'payload', 'UpdateShareRequest schema mismatch');
    }
    const share = this.shares.get(id)!;
    if (request.expiresAt !== undefined) share.expiresAt = request.expiresAt;
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'updateShare', DriveStatus.ok, share);
  }

  private handleRevokeShare(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('revokeShare');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'revokeShare');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'revokeShare');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'revokeShare');
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'revokeShare', cached.status, cached.body);
    }
    if (mode === '404' || !this.shares.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'revokeShare', DriveStatus.notFound, errorBody('SHARE_NOT_FOUND', `No share with id ${id}`));
    }
    this.shares.delete(id);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, { status: DriveStatus.noContent, body: null });
    this.recordRequest(method, path, headers, body, DriveStatus.noContent);
    return this.respond(res, 'revokeShare', DriveStatus.noContent, null);
  }

  private handleListShares(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string, query: URLSearchParams): void {
    const mode = this.mode('listShares');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'listShares');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'listShares');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'listShares');
    const ownerId = Number(query.get('ownerId') ?? '0');
    const mediaId = query.get('mediaId') ?? undefined;
    const items = [...this.shares.values()].filter((s) => ownerId === 0 || s.ownerId === ownerId);
    const filtered = mediaId ? items.filter((s) => s.mediaId === mediaId) : items;
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'listShares', DriveStatus.ok, filtered);
  }

  private handleMoveToTrash(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('moveToTrash');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'moveToTrash');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'moveToTrash');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'moveToTrash', 'mediaId', 'must be a non-empty string');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'moveToTrash', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'moveToTrash');
    const request = body as Partial<MoveToTrashRequest> | undefined;
    if (!request || typeof request.mediaId !== 'string' || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'moveToTrash', 'payload', 'MoveToTrashRequest schema mismatch');
    }
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'moveToTrash', cached.status, cached.body);
    }
    const record: TrashRecord = {
      id: randomUUID(),
      mediaId: request.mediaId,
      ownerId: request.ownerId,
      trashedAt: new Date().toISOString(),
    };
    this.trash.set(record.id, record);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, { status: DriveStatus.created, body: record });
    this.recordRequest(method, path, headers, body, DriveStatus.created);
    return this.respond(res, 'moveToTrash', DriveStatus.created, record);
  }

  private handleRestoreTrash(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/')[4] ?? '';
    const mode = this.mode('restoreTrash');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'restoreTrash');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'restoreTrash');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'restoreTrash', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'restoreTrash');
    if (mode === '404' || !this.trash.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'restoreTrash', DriveStatus.notFound, errorBody('TRASH_NOT_FOUND', `No trash item with id ${id}`));
    }
    const trashed = this.trash.get(id)!;
    const request = body as Partial<RestoreTrashRequest> | undefined;
    if (!request || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'restoreTrash', 'payload', 'RestoreTrashRequest schema mismatch');
    }
    // Restore: remove from trash and return the underlying media record if it exists.
    this.trash.delete(id);
    const media = this.media.get(trashed.mediaId);
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'restoreTrash', DriveStatus.ok, media ?? { id: trashed.mediaId, ownerId: trashed.ownerId, provider: 'unknown', canonicalUrl: '', originalUrl: '', title: '', mimeType: '', quality: '', checksum: '', fileId: '', messageId: 0, chatId: '' });
  }

  private handleListFavorites(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string, query: URLSearchParams): void {
    const mode = this.mode('listFavorites');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'listFavorites');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'listFavorites');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'listFavorites');
    const ownerId = Number(query.get('ownerId') ?? '0');
    const items = [...this.favorites.values()].filter((f) => ownerId === 0 || f.ownerId === ownerId);
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'listFavorites', DriveStatus.ok, items);
  }

  private handleCleanupRecent(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const mode = this.mode('cleanupRecent');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'cleanupRecent');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'cleanupRecent');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'cleanupRecent', 'ownerId', 'must be a number');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'cleanupRecent', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'cleanupRecent');
    const request = body as Partial<CleanupRecentRequest> | undefined;
    if (!request || typeof request.ownerId !== 'number') {
      return this.failValidation(res, method, path, headers, body, 'cleanupRecent', 'payload', 'CleanupRecentRequest schema mismatch');
    }
    const keep = request.keep ?? 100;
    const ownerRecents = [...this.recents.values()]
      .filter((r) => r.ownerId === request.ownerId)
      .sort((a, b) => b.accessedAt.localeCompare(a.accessedAt));
    const toRemove = ownerRecents.slice(keep);
    for (const r of toRemove) this.recents.delete(r.id);
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'cleanupRecent', DriveStatus.ok, { removed: toRemove.length, kept: ownerRecents.length - toRemove.length });
  }

  private handleUpdateCollaborator(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('updateCollaborator');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'updateCollaborator');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'updateCollaborator');
    if (mode === '422') return this.failValidation(res, method, path, headers, body, 'updateCollaborator', 'role', 'must be viewer/editor/owner');
    if (mode === '429') return this.failRateLimited(res, method, path, headers, body, 'updateCollaborator', 5);
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'updateCollaborator');
    if (mode === '404' || !this.collaborations.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'updateCollaborator', DriveStatus.notFound, errorBody('COLLABORATION_NOT_FOUND', `No collaboration with id ${id}`));
    }
    const request = body as Partial<UpdateCollaboratorRequest> | undefined;
    if (!request || typeof request.inviterId !== 'number' || typeof request.role !== 'string') {
      return this.failValidation(res, method, path, headers, body, 'updateCollaborator', 'payload', 'UpdateCollaboratorRequest schema mismatch');
    }
    const invite = this.collaborations.get(id)!;
    invite.role = request.role as CollaborationInvite['role'];
    if (request.status) invite.status = request.status;
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'updateCollaborator', DriveStatus.ok, invite);
  }

  private handleRemoveCollaborator(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const id = path.split('/').pop() ?? '';
    const mode = this.mode('removeCollaborator');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'removeCollaborator');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'removeCollaborator');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'removeCollaborator');
    const idempotencyKey = headers[DriveHeaders.idempotencyKey.toLowerCase()];
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) {
      const cached = this.idempotency.get(idempotencyKey)!;
      this.recordRequest(method, path, headers, body, cached.status);
      return this.respond(res, 'removeCollaborator', cached.status, cached.body);
    }
    if (mode === '404' || !this.collaborations.has(id)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'removeCollaborator', DriveStatus.notFound, errorBody('COLLABORATION_NOT_FOUND', `No collaboration with id ${id}`));
    }
    const removed = this.collaborations.get(id)!;
    this.collaborations.delete(id);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, { status: DriveStatus.noContent, body: null });
    this.recordRequest(method, path, headers, body, DriveStatus.noContent);
    void removed;
    return this.respond(res, 'removeCollaborator', DriveStatus.noContent, null);
  }

  private handleListCollaborators(method: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse, path: string): void {
    const folderId = path.split('/').pop() ?? '';
    const mode = this.mode('listCollaborators');
    if (mode === '401') return this.failAuth(res, method, path, headers, body, 'listCollaborators');
    if (mode === '403') return this.failForbidden(res, method, path, headers, body, 'listCollaborators');
    if (mode === '500') return this.failInternal(res, method, path, headers, body, 'listCollaborators');
    if (mode === '404' || !this.folders.has(folderId)) {
      this.recordRequest(method, path, headers, body, DriveStatus.notFound);
      return this.respond(res, 'listCollaborators', DriveStatus.notFound, errorBody('FOLDER_NOT_FOUND', `No folder with id ${folderId}`));
    }
    const items = [...this.collaborations.values()].filter((c) => c.folderId === folderId);
    this.recordRequest(method, path, headers, body, DriveStatus.ok);
    return this.respond(res, 'listCollaborators', DriveStatus.ok, items);
  }

  // -------------------------------------------------------------------------
  // Failure-mode helpers (DRY for the new endpoints)
  // -------------------------------------------------------------------------

  private failAuth(res: http.ServerResponse, method: string, path: string, headers: Record<string, string>, body: unknown, endpoint: EndpointName): void {
    this.recordRequest(method, path, headers, body, DriveStatus.notAuthenticated);
    this.respond(res, endpoint, DriveStatus.notAuthenticated, errorBody('UNAUTHENTICATED', `mock injected 401 on ${endpoint}`));
  }

  private failForbidden(res: http.ServerResponse, method: string, path: string, headers: Record<string, string>, body: unknown, endpoint: EndpointName): void {
    this.recordRequest(method, path, headers, body, DriveStatus.forbidden);
    this.respond(res, endpoint, DriveStatus.forbidden, errorBody('FORBIDDEN', `mock injected 403 on ${endpoint}`));
  }

  private failConflict(res: http.ServerResponse, method: string, path: string, headers: Record<string, string>, body: unknown, endpoint: EndpointName, message: string): void {
    this.recordRequest(method, path, headers, body, DriveStatus.conflict);
    this.respond(res, endpoint, DriveStatus.conflict, conflictBody(message));
  }

  private failValidation(res: http.ServerResponse, method: string, path: string, headers: Record<string, string>, body: unknown, endpoint: EndpointName, field: string, message: string): void {
    this.recordRequest(method, path, headers, body, DriveStatus.unprocessable);
    this.respond(res, endpoint, DriveStatus.unprocessable, validationErrorBody(field, message));
  }

  private failRateLimited(res: http.ServerResponse, method: string, path: string, headers: Record<string, string>, body: unknown, endpoint: EndpointName, retryAfter: number): void {
    this.recordRequest(method, path, headers, body, DriveStatus.rateLimited);
    this.respond(res, endpoint, DriveStatus.rateLimited, rateLimitedBody(retryAfter));
  }

  private failInternal(res: http.ServerResponse, method: string, path: string, headers: Record<string, string>, body: unknown, endpoint: EndpointName): void {
    this.recordRequest(method, path, headers, body, DriveStatus.internalError);
    this.respond(res, endpoint, DriveStatus.internalError, errorBody('INTERNAL', `mock injected 500 on ${endpoint}`));
  }

  private hang(method: string, path: string, headers: Record<string, string>, body: unknown): void {
    this.recordRequest(method, path, headers, body, 0);
  }

  private destroy(method: string, path: string, headers: Record<string, string>, body: unknown, res: http.ServerResponse): void {
    this.recordRequest(method, path, headers, body, 0);
    res.destroy();
  }

  private recordRequest(method: string, path: string, headers: Record<string, string>, body: unknown, status: number): void {
    this.requestLog.push({
      method,
      path,
      headers,
      body,
      status,
      receivedAt: new Date().toISOString(),
    });
  }

  private respond(res: http.ServerResponse, _endpoint: EndpointName | null, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    if (status === DriveStatus.noContent || body === null || body === undefined) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function lowercaseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      result[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      result[key.toLowerCase()] = value.join(', ');
    }
  }
  return result;
}

function isCreateMediaRequest(value: unknown): value is CreateMediaRequest {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.ownerId === 'number' &&
    typeof r.provider === 'string' &&
    typeof r.canonicalUrl === 'string' &&
    typeof r.originalUrl === 'string' &&
    typeof r.title === 'string' &&
    typeof r.mimeType === 'string' &&
    typeof r.quality === 'string' &&
    typeof r.checksum === 'string' &&
    typeof r.fileId === 'string' &&
    typeof r.messageId === 'number' &&
    typeof r.chatId === 'string'
  );
}

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

function conflictBody(message: string): unknown {
  return { error: { code: 'CONFLICT', message, idempotencyConflict: true } };
}

function validationErrorBody(field: string, message: string): unknown {
  return { error: { code: 'VALIDATION_ERROR', message: `${field}: ${message}`, details: [{ field, message }] } };
}

function rateLimitedBody(retryAfter: number): unknown {
  return { error: { code: 'RATE_LIMITED', message: 'Too many requests', retryAfter } };
}

/** Exposed for tests that need to construct a valid API key. */
export const MOCK_DRIVE_API_KEY = VALID_API_KEY;
export { DriveEndpoints };
