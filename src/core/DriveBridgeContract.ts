/**
 * DriveBridgeContract captures the v1 API Bridge surface that the Telegram
 * Media Downloader uses to talk to Telegram Drive. It is a compatibility
 * reference: every endpoint, header, status code, and schema field listed
 * here is the contract that the downloader's `DriveApiClient` and the
 * `CompatibilityChecker` rely on. The contract itself is owned by the
 * Telegram Drive service (finalised in Stages 2.0-2.7) and MUST NOT be
 * changed from this side.
 *
 * Stage 2.9 uses this contract to:
 *  - generate the mock Drive server (`tests/mockDriveServer.ts`)
 *  - drive the integration test suite (`tests/driveApiIntegration.test.ts`)
 *  - verify version + schema compatibility at runtime
 *
 * Authentication: every non-public endpoint requires the `X-API-Key`
 * header set to the API key provisioned by the Drive operator and stored
 * in `DRIVE_API_KEY`. The downloader never logs the key. (Stage 4.0:
 * auth switched from `Authorization: Bearer` to `X-API-Key` to match the
 * telegram-drive Stage 3.x contract.)
 *
 * Idempotency: every mutating endpoint (`POST`, `DELETE`) accepts an
 * optional `Idempotency-Key` header. The Drive deduplicates requests
 * with the same key for 24h. The downloader generates a key per logical
 * operation (typically the queue job id) so retries after a network
 * failure do not create duplicate records.
 *
 * Versioning: every path is prefixed with `/api/v1/`. A `GET
 * /api/v1/integration/version` endpoint reports the running version. The
 * downloader treats `engineCompatibility` as the source of truth: if the
 * Drive reports a version outside the downloader's compatible range, the
 * compatibility checker fails.
 */

export const DRIVE_API_VERSION = 'v1' as const;
export const DRIVE_API_PREFIX = `/api/${DRIVE_API_VERSION}` as const;

/** Compatible Drive version range (semver). The checker uses this. */
export const DRIVE_COMPATIBLE_RANGE = '^3.0.0' as const;

/** Endpoint paths. Exposed for tests and the mock server. */
export const DriveEndpoints = {
  health: `${DRIVE_API_PREFIX}/integration/health`,
  version: `${DRIVE_API_PREFIX}/integration/version`,
  createMedia: `${DRIVE_API_PREFIX}/media`,
  getMedia: (id: string) => `${DRIVE_API_PREFIX}/media/${encodeURIComponent(id)}`,
  deleteMedia: (id: string) => `${DRIVE_API_PREFIX}/media/${encodeURIComponent(id)}`,
  syncMedia: (id: string) => `${DRIVE_API_PREFIX}/media/${encodeURIComponent(id)}/sync`,
  // Stage 4.0 / 4.1 — folder surface.
  folders: `${DRIVE_API_PREFIX}/folders`,
  folder: (id: string) => `${DRIVE_API_PREFIX}/folders/${encodeURIComponent(id)}`,
  folderMedia: (folderId: string) => `${DRIVE_API_PREFIX}/folders/${encodeURIComponent(folderId)}/media`,
  folderMove: (id: string) => `${DRIVE_API_PREFIX}/folders/${encodeURIComponent(id)}/move`,
  // Stage 4.0 / 4.1 — share surface.
  share: (id: string) => `${DRIVE_API_PREFIX}/share/${encodeURIComponent(id)}`,
  shareUpdate: (id: string) => `${DRIVE_API_PREFIX}/share/${encodeURIComponent(id)}/update`,
  // Stage 4.0 / 4.1 — trash surface.
  trash: `${DRIVE_API_PREFIX}/trash`,
  trashItem: (id: string) => `${DRIVE_API_PREFIX}/trash/${encodeURIComponent(id)}`,
  trashRestore: (id: string) => `${DRIVE_API_PREFIX}/trash/${encodeURIComponent(id)}/restore`,
  // Stage 4.0 / 4.1 — favorite surface.
  favorite: `${DRIVE_API_PREFIX}/favorites`,
  favoriteItem: (id: string) => `${DRIVE_API_PREFIX}/favorites/${encodeURIComponent(id)}`,
  // Stage 4.0 / 4.1 — recent surface.
  recent: `${DRIVE_API_PREFIX}/recent`,
  recentCleanup: `${DRIVE_API_PREFIX}/recent/cleanup`,
  // Stage 4.0 / 4.1 — collaboration surface.
  collaboration: `${DRIVE_API_PREFIX}/collaboration`,
  collaborationInvite: (id: string) => `${DRIVE_API_PREFIX}/collaboration/${encodeURIComponent(id)}/invite`,
  collaborationItem: (id: string) => `${DRIVE_API_PREFIX}/collaboration/${encodeURIComponent(id)}`,
} as const;

/** Headers used by the Bridge contract. */
export const DriveHeaders = {
  /** Stage 4.0: auth is via X-API-Key, not Authorization: Bearer. */
  apiKey: 'X-API-Key',
  idempotencyKey: 'Idempotency-Key',
  apiVersion: 'X-Api-Version',
  client: 'X-Client',
  accept: 'Accept',
  contentType: 'Content-Type',
} as const;

/** Status codes the Bridge contractually returns. */
export const DriveStatus = {
  ok: 200,
  created: 201,
  accepted: 202,
  noContent: 204,
  notAuthenticated: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unprocessable: 422,
  rateLimited: 429,
  internalError: 500,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  version?: string;
  timestamp?: string;
  checks?: Record<string, unknown>;
}

export interface VersionResponse {
  service: string;
  version: string;
  apiVersion: string;
  engineCompatibility?: string;
  build?: string;
}

export interface MediaRecord {
  id: string;
  ownerId: number;
  provider: string;
  canonicalUrl: string;
  originalUrl: string;
  title: string;
  description?: string;
  duration?: number;
  thumbnail?: string;
  mimeType: string;
  quality: string;
  resolution?: string;
  size?: number;
  checksum: string;
  fileId: string;
  messageId: number;
  chatId: string;
  uploadDate: string;
}

export interface CreateMediaRequest {
  id: string;
  ownerId: number;
  provider: string;
  canonicalUrl: string;
  originalUrl: string;
  title: string;
  description?: string;
  duration?: number;
  thumbnail?: string;
  mimeType: string;
  quality: string;
  resolution?: string;
  size?: number;
  checksum: string;
  fileId: string;
  messageId: number;
  chatId: string;
}

export type CreateMediaResponse = MediaRecord;

export interface SyncMediaRequest {
  /** Optional field-level override; otherwise a full re-sync is requested. */
  fields?: string[];
}

export interface SyncMediaResponse {
  id: string;
  status: 'synced' | 'queued';
  syncId?: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    /** Stable machine-readable error slug, e.g. `MEDIA_NOT_FOUND`. */
    slug?: string;
    /** Present when the request violated a schema constraint. */
    details?: Array<{ field: string; message: string }>;
    /** Present when the request was rate limited. Seconds. */
    retryAfter?: number;
    /** Present when the request collided with an in-flight idempotent call. */
    idempotencyConflict?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Stage 4.0 — folder / share / trash / favorite / recent / collaboration
// ---------------------------------------------------------------------------

export interface FolderRecord {
  id: string;
  ownerId: number;
  name: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFolderRequest {
  id: string;
  ownerId: number;
  name: string;
  parentId?: string;
}

export type CreateFolderResponse = FolderRecord;

export interface AddMediaToFolderRequest {
  mediaId: string;
  ownerId: number;
}

export interface ShareRecord {
  id: string;
  mediaId: string;
  ownerId: number;
  token: string;
  expiresAt?: string;
  createdAt: string;
}

export interface CreateShareRequest {
  mediaId: string;
  ownerId: number;
  expiresAt?: string;
}

export type CreateShareResponse = ShareRecord;

export interface TrashRecord {
  id: string;
  mediaId: string;
  ownerId: number;
  trashedAt: string;
}

export interface FavoriteRecord {
  id: string;
  mediaId: string;
  ownerId: number;
  createdAt: string;
}

export interface FavoriteRequest {
  mediaId: string;
  ownerId: number;
}

export type FavoriteResponse = FavoriteRecord;

export interface RecentRecord {
  id: string;
  mediaId: string;
  ownerId: number;
  accessedAt: string;
}

export interface RecentRequest {
  mediaId: string;
  ownerId: number;
}

export type RecentResponse = RecentRecord;

export interface CollaborationInvite {
  id: string;
  folderId: string;
  inviterId: number;
  inviteeId: number;
  role: 'viewer' | 'editor' | 'owner';
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

export interface CollaborationInviteRequest {
  folderId: string;
  inviterId: number;
  inviteeId: number;
  role: 'viewer' | 'editor' | 'owner';
}

export type CollaborationInviteResponse = CollaborationInvite;

// ---------------------------------------------------------------------------
// Stage 4.1 — extended folder / share / trash / favorite / recent /
// collaboration operations (rename, move, delete, list, update, revoke,
// restore, cleanup, permission update, remove, list collaborators).
// ---------------------------------------------------------------------------

export interface RenameFolderRequest {
  name: string;
  ownerId: number;
}

export type RenameFolderResponse = FolderRecord;

export interface MoveFolderRequest {
  parentId?: string;
  ownerId: number;
}

export type MoveFolderResponse = FolderRecord;

export interface ListFoldersRequest {
  ownerId: number;
  parentId?: string;
}

export type ListFoldersResponse = FolderRecord[];

export interface UpdateShareRequest {
  ownerId: number;
  expiresAt?: string;
}

export type UpdateShareResponse = ShareRecord;

export interface ListSharesRequest {
  ownerId: number;
  mediaId?: string;
}

export type ListSharesResponse = ShareRecord[];

export interface MoveToTrashRequest {
  mediaId: string;
  ownerId: number;
}

export type MoveToTrashResponse = TrashRecord;

export interface RestoreTrashRequest {
  ownerId: number;
}

export type RestoreTrashResponse = MediaRecord;

export interface ListFavoritesRequest {
  ownerId: number;
}

export type ListFavoritesResponse = FavoriteRecord[];

export interface CleanupRecentRequest {
  ownerId: number;
  /** Maximum number of recent entries to keep per owner. */
  keep?: number;
}

export interface CleanupRecentResponse {
  removed: number;
  kept: number;
}

export interface UpdateCollaboratorRequest {
  inviterId: number;
  role: 'viewer' | 'editor' | 'owner';
  status?: 'pending' | 'accepted' | 'declined';
}

export type UpdateCollaboratorResponse = CollaborationInvite;

export type RemoveCollaboratorResponse = CollaborationInvite;

export interface ListCollaboratorsRequest {
  folderId: string;
}

export type ListCollaboratorsResponse = CollaborationInvite[];

// ---------------------------------------------------------------------------
// Compatibility spec
// ---------------------------------------------------------------------------

export interface EndpointSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** true when the endpoint requires the Authorization header. */
  authenticated: boolean;
  /** true when the endpoint honours the Idempotency-Key header. */
  idempotent: boolean;
  /** Request body schema name, if any. */
  requestSchema?: string;
  /** Response body schema name. */
  responseSchema: string;
  /** Status codes the endpoint can return. */
  statuses: number[];
}

export const DriveContractSpec: EndpointSpec[] = [
  {
    method: 'GET',
    path: DriveEndpoints.health,
    authenticated: false,
    idempotent: false,
    responseSchema: 'HealthResponse',
    statuses: [DriveStatus.ok, DriveStatus.serviceUnavailable, DriveStatus.internalError],
  },
  {
    method: 'GET',
    path: DriveEndpoints.version,
    authenticated: true,
    idempotent: false,
    responseSchema: 'VersionResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.internalError],
  },
  {
    method: 'POST',
    path: DriveEndpoints.createMedia,
    authenticated: true,
    idempotent: true,
    requestSchema: 'CreateMediaRequest',
    responseSchema: 'CreateMediaResponse',
    statuses: [
      DriveStatus.created,
      DriveStatus.ok,
      DriveStatus.notAuthenticated,
      DriveStatus.forbidden,
      DriveStatus.conflict,
      DriveStatus.unprocessable,
      DriveStatus.rateLimited,
      DriveStatus.internalError,
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/media/:id',
    authenticated: true,
    idempotent: false,
    responseSchema: 'MediaRecord',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.internalError],
  },
  {
    method: 'DELETE',
    path: '/api/v1/media/:id',
    authenticated: true,
    idempotent: true,
    responseSchema: 'ErrorResponse',
    statuses: [DriveStatus.noContent, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.internalError],
  },
  {
    method: 'POST',
    path: '/api/v1/media/:id/sync',
    authenticated: true,
    idempotent: true,
    requestSchema: 'SyncMediaRequest',
    responseSchema: 'SyncMediaResponse',
    statuses: [DriveStatus.accepted, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  // Stage 4.0 — folder endpoints
  {
    method: 'POST',
    path: DriveEndpoints.folders,
    authenticated: true,
    idempotent: true,
    requestSchema: 'CreateFolderRequest',
    responseSchema: 'CreateFolderResponse',
    statuses: [DriveStatus.created, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  {
    method: 'GET',
    path: '/api/v1/folders/:id',
    authenticated: true,
    idempotent: false,
    responseSchema: 'FolderRecord',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.internalError],
  },
  {
    method: 'POST',
    path: '/api/v1/folders/:id/media',
    authenticated: true,
    idempotent: true,
    requestSchema: 'AddMediaToFolderRequest',
    responseSchema: 'ErrorResponse',
    statuses: [DriveStatus.created, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  // Stage 4.0 — share endpoint
  {
    method: 'POST',
    path: DriveEndpoints.share(':id'),
    authenticated: true,
    idempotent: true,
    requestSchema: 'CreateShareRequest',
    responseSchema: 'CreateShareResponse',
    statuses: [DriveStatus.created, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  // Stage 4.0 — trash endpoints
  {
    method: 'GET',
    path: DriveEndpoints.trash,
    authenticated: true,
    idempotent: false,
    responseSchema: 'TrashRecord',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.internalError],
  },
  {
    method: 'DELETE',
    path: '/api/v1/trash/:id',
    authenticated: true,
    idempotent: true,
    responseSchema: 'ErrorResponse',
    statuses: [DriveStatus.noContent, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.internalError],
  },
  // Stage 4.0 — favorite endpoints
  {
    method: 'POST',
    path: DriveEndpoints.favorite,
    authenticated: true,
    idempotent: true,
    requestSchema: 'FavoriteRequest',
    responseSchema: 'FavoriteResponse',
    statuses: [DriveStatus.created, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  {
    method: 'DELETE',
    path: '/api/v1/favorites/:id',
    authenticated: true,
    idempotent: true,
    responseSchema: 'ErrorResponse',
    statuses: [DriveStatus.noContent, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.internalError],
  },
  // Stage 4.0 — recent endpoint
  {
    method: 'POST',
    path: DriveEndpoints.recent,
    authenticated: true,
    idempotent: true,
    requestSchema: 'RecentRequest',
    responseSchema: 'RecentResponse',
    statuses: [DriveStatus.created, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  // Stage 4.0 — collaboration endpoint
  {
    method: 'POST',
    path: DriveEndpoints.collaborationInvite(':id'),
    authenticated: true,
    idempotent: true,
    requestSchema: 'CollaborationInviteRequest',
    responseSchema: 'CollaborationInviteResponse',
    statuses: [DriveStatus.created, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  // Stage 4.1 — folder rename/move/delete/list
  {
    method: 'POST',
    path: '/api/v1/folders/:id/move',
    authenticated: true,
    idempotent: true,
    requestSchema: 'MoveFolderRequest',
    responseSchema: 'MoveFolderResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  {
    method: 'DELETE',
    path: '/api/v1/folders/:id',
    authenticated: true,
    idempotent: true,
    responseSchema: 'ErrorResponse',
    statuses: [DriveStatus.noContent, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.internalError],
  },
  {
    method: 'GET',
    path: DriveEndpoints.folders,
    authenticated: true,
    idempotent: false,
    responseSchema: 'ListFoldersResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.internalError],
  },
  // Stage 4.1 — share update/revoke/list
  {
    method: 'POST',
    path: '/api/v1/share/:id/update',
    authenticated: true,
    idempotent: true,
    requestSchema: 'UpdateShareRequest',
    responseSchema: 'UpdateShareResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  {
    method: 'DELETE',
    path: '/api/v1/share/:id',
    authenticated: true,
    idempotent: true,
    responseSchema: 'ErrorResponse',
    statuses: [DriveStatus.noContent, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.internalError],
  },
  {
    method: 'GET',
    path: DriveEndpoints.share('list'),
    authenticated: true,
    idempotent: false,
    responseSchema: 'ListSharesResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.internalError],
  },
  // Stage 4.1 — trash move-to-trash + restore
  {
    method: 'POST',
    path: DriveEndpoints.trash,
    authenticated: true,
    idempotent: true,
    requestSchema: 'MoveToTrashRequest',
    responseSchema: 'MoveToTrashResponse',
    statuses: [DriveStatus.created, DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  {
    method: 'POST',
    path: '/api/v1/trash/:id/restore',
    authenticated: true,
    idempotent: true,
    requestSchema: 'RestoreTrashRequest',
    responseSchema: 'RestoreTrashResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  // Stage 4.1 — favorite list
  {
    method: 'GET',
    path: DriveEndpoints.favorite,
    authenticated: true,
    idempotent: false,
    responseSchema: 'ListFavoritesResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.internalError],
  },
  // Stage 4.1 — recent cleanup
  {
    method: 'POST',
    path: DriveEndpoints.recentCleanup,
    authenticated: true,
    idempotent: true,
    requestSchema: 'CleanupRecentRequest',
    responseSchema: 'CleanupRecentResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  // Stage 4.1 — collaboration update/remove/list
  {
    method: 'POST',
    path: '/api/v1/collaboration/:id',
    authenticated: true,
    idempotent: true,
    requestSchema: 'UpdateCollaboratorRequest',
    responseSchema: 'UpdateCollaboratorResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.conflict, DriveStatus.unprocessable, DriveStatus.rateLimited, DriveStatus.internalError],
  },
  {
    method: 'DELETE',
    path: '/api/v1/collaboration/:id',
    authenticated: true,
    idempotent: true,
    responseSchema: 'ErrorResponse',
    statuses: [DriveStatus.noContent, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.internalError],
  },
  {
    method: 'GET',
    path: '/api/v1/collaboration/:folderId',
    authenticated: true,
    idempotent: false,
    responseSchema: 'ListCollaboratorsResponse',
    statuses: [DriveStatus.ok, DriveStatus.notAuthenticated, DriveStatus.forbidden, DriveStatus.notFound, DriveStatus.internalError],
  },
];

/** Schema field names used by the checker to verify response shape. */
export const DriveSchemas: Record<string, string[]> = {
  HealthResponse: ['status', 'service'],
  VersionResponse: ['service', 'version', 'apiVersion'],
  MediaRecord: ['id', 'ownerId', 'provider', 'canonicalUrl', 'mimeType', 'quality', 'checksum', 'fileId', 'messageId', 'chatId'],
  CreateMediaRequest: ['id', 'ownerId', 'provider', 'canonicalUrl', 'mimeType', 'quality', 'checksum', 'fileId', 'messageId', 'chatId'],
  CreateMediaResponse: ['id', 'ownerId', 'provider', 'canonicalUrl', 'mimeType', 'quality', 'checksum', 'fileId', 'messageId', 'chatId'],
  SyncMediaResponse: ['id', 'status'],
  ErrorResponse: ['error', 'error.code', 'error.message'],
  // Stage 4.0
  FolderRecord: ['id', 'ownerId', 'name'],
  CreateFolderRequest: ['id', 'ownerId', 'name'],
  CreateFolderResponse: ['id', 'ownerId', 'name'],
  AddMediaToFolderRequest: ['mediaId', 'ownerId'],
  ShareRecord: ['id', 'mediaId', 'ownerId', 'token'],
  CreateShareRequest: ['mediaId', 'ownerId'],
  CreateShareResponse: ['id', 'mediaId', 'ownerId', 'token'],
  TrashRecord: ['id', 'mediaId', 'ownerId'],
  FavoriteRecord: ['id', 'mediaId', 'ownerId'],
  FavoriteRequest: ['mediaId', 'ownerId'],
  FavoriteResponse: ['id', 'mediaId', 'ownerId'],
  RecentRecord: ['id', 'mediaId', 'ownerId'],
  RecentRequest: ['mediaId', 'ownerId'],
  RecentResponse: ['id', 'mediaId', 'ownerId'],
  CollaborationInvite: ['id', 'folderId', 'inviterId', 'inviteeId', 'role'],
  CollaborationInviteRequest: ['folderId', 'inviterId', 'inviteeId', 'role'],
  CollaborationInviteResponse: ['id', 'folderId', 'inviterId', 'inviteeId', 'role'],
  // Stage 4.1
  RenameFolderRequest: ['name', 'ownerId'],
  RenameFolderResponse: ['id', 'ownerId', 'name'],
  MoveFolderRequest: ['ownerId'],
  MoveFolderResponse: ['id', 'ownerId', 'name'],
  ListFoldersResponse: [],
  UpdateShareRequest: ['ownerId'],
  UpdateShareResponse: ['id', 'mediaId', 'ownerId', 'token'],
  ListSharesResponse: [],
  MoveToTrashRequest: ['mediaId', 'ownerId'],
  MoveToTrashResponse: ['id', 'mediaId', 'ownerId'],
  RestoreTrashRequest: ['ownerId'],
  RestoreTrashResponse: ['id', 'ownerId', 'provider', 'canonicalUrl'],
  ListFavoritesResponse: [],
  CleanupRecentRequest: ['ownerId'],
  CleanupRecentResponse: ['removed', 'kept'],
  UpdateCollaboratorRequest: ['inviterId', 'role'],
  UpdateCollaboratorResponse: ['id', 'folderId', 'inviterId', 'inviteeId', 'role'],
  RemoveCollaboratorResponse: ['id', 'folderId', 'inviterId', 'inviteeId', 'role'],
  ListCollaboratorsResponse: [],
};
