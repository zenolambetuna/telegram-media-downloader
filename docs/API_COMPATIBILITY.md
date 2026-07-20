# API Compatibility Reference (Stage 2.9 / Stage 4.0)

This document is the canonical reference for the Telegram Drive Bridge v1
API contract as observed by the Telegram Media Downloader. The contract
itself is owned by the Telegram Drive service (finalised in Stages
2.0-2.7 for the core surface, extended in Stage 3.x with folder/share/
trash/favorite/recent/collaboration) and MUST NOT be changed from this
side. The downloader's `src/core/DriveBridgeContract.ts` is the
TypeScript mirror of this document — keep the two in sync when the
upstream contract evolves.

## Versioning

- Every path is prefixed with `/api/v1/`.
- `GET /api/v1/integration/version` reports the running version plus the
  Drive's `engineCompatibility` range.
- The downloader's compatible range is `^3.0.0`
  (`DRIVE_COMPATIBLE_RANGE` in `DriveBridgeContract.ts`). The
  `CompatibilityChecker` fails the report when the Drive reports a version
  outside this range.
- The `X-Api-Version` request header carries the full prefix (`/api/v1`)
  so the Drive can detect mismatched clients.
- The `X-Client` request header carries `telegram-media-downloader` so the
  Drive can attribute traffic.

## Authentication

- Every endpoint except `/integration/health` requires the `X-API-Key`
  header set to the Drive API key (`DRIVE_API_KEY`).
  - Stage 4.0 note: auth switched from `Authorization: Bearer` to
    `X-API-Key` to match the telegram-drive Stage 3.x contract.
- Missing or invalid credentials return `401` with an `ErrorResponse`
  body whose `error.code` is `UNAUTHENTICATED`.
- The downloader never logs the API key. Pino's `redact` config strips
  `token`, `apiKey`, `authorization`, `cookie`, `password`, `secret` from
  every log record, and `sanitizeForLog()` does the same for arbitrary
  payloads.

## Idempotency

- Every mutating endpoint (`POST`, `DELETE`) accepts an optional
  `Idempotency-Key` header.
- The Drive deduplicates requests with the same key for 24h. Replaying a
  request with the same key returns the original response.
- The downloader generates a key per logical operation — typically the
  queue job id — so retries after a network failure do not create
  duplicate records.
- A replay that collides with an in-flight request returns `409
  Conflict` with `error.idempotencyConflict: true`.

## Endpoints

### `GET /api/v1/integration/health`

Unauthenticated. Returns `HealthResponse`:

```json
{
  "status": "ok" | "degraded" | "down",
  "service": "drive",
  "version": "3.2.1",
  "timestamp": "2026-07-19T...",
  "checks": { "database": "ok", "storage": "ok" }
}
```

Statuses: `200`, `503`, `500`.

### `GET /api/v1/integration/version`

Authenticated. Returns `VersionResponse`:

```json
{
  "service": "drive",
  "version": "3.2.1",
  "apiVersion": "v1",
  "engineCompatibility": "^3.0.0",
  "build": "2026.07"
}
```

Statuses: `200`, `401`, `500`.

### `POST /api/v1/media`

Authenticated, idempotent. Creates or upserts a media record. Request
body is `CreateMediaRequest`; response is `CreateMediaResponse` (the
stored `MediaRecord`).

```json
{
  "id": "media-1",
  "ownerId": 1,
  "provider": "youtube",
  "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "originalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Sample",
  "description": "...",
  "duration": 212,
  "thumbnail": "https://...",
  "mimeType": "video/mp4",
  "quality": "720p",
  "resolution": "1280x720",
  "size": 5000000,
  "checksum": "sha256:abc",
  "fileId": "file-1",
  "messageId": 42,
  "chatId": "-100123"
}
```

Statuses: `201`, `200`, `401`, `403`, `409`, `422`, `429`, `500`.

- `409` — a media with the same checksum already exists for a different
  id. Permanent; do not retry.
- `422` — schema violation. The body `error.details` lists the failing
  fields. Permanent; fix the payload.
- `429` — rate limited. The body `error.retryAfter` is the wait in
  seconds. Retryable.

### `GET /api/v1/media/:id`

Authenticated. Returns the stored `MediaRecord`.

Statuses: `200`, `401`, `403`, `404`, `500`.

### `DELETE /api/v1/media/:id`

Authenticated, idempotent. Deletes the record. Returns `204 No Content`
on success.

Statuses: `204`, `401`, `403`, `404`, `409`, `500`.

- `409` — the media is referenced by an active sync.

### `POST /api/v1/media/:id/sync`

Authenticated, idempotent. Triggers a re-sync. Request body is
`SyncMediaRequest` (`{ "fields"?: string[] }`); response is
`SyncMediaResponse`:

```json
{ "id": "media-1", "status": "queued", "syncId": "..." }
```

Statuses: `202`, `200`, `401`, `403`, `404`, `409`, `429`, `500`.

## Error response

Every non-2xx response uses the `ErrorResponse` shape:

```json
{
  "error": {
    "code": "MEDIA_NOT_FOUND",
    "message": "No media with id ...",
    "slug": "media_not_found",
    "details": [{ "field": "ownerId", "message": "..." }],
    "retryAfter": 5,
    "idempotencyConflict": true
  }
}
```

Only `error.code` and `error.message` are required; the rest are
optional and context-dependent.

## Status code → retry policy

The downloader's `categorize()` function maps Drive status codes to
queue-worker retry behaviour:

| Status | Category | Retry? |
| --- | --- | --- |
| 401 | `telegram` (auth) | No (config issue) |
| 403 | `permanent` | No |
| 404 | `permanent` | No |
| 409 | `permanent` | No |
| 422 | `validation` | No |
| 429 | `telegram` (rate limit) | Yes (backoff) |
| 500 | `retryable` | Yes (backoff) |
| 502/503/504 | `network` | Yes (backoff) |
| 0 (network) | `network` | Yes (backoff) |
| -1 (timeout) | `network` | Yes (backoff) |

The queue worker retries up to `QUEUE_MAX_RETRIES + 1` times with
exponential backoff (capped at 5 minutes), then dead-letters the job.

## Schema verification

`DriveSchemas` in `DriveBridgeContract.ts` lists the required top-level
fields for every response schema. The `CompatibilityChecker` uses it to
verify the Drive's responses match the contract:

- `HealthResponse` — `status`, `service`
- `VersionResponse` — `service`, `version`, `apiVersion`
- `MediaRecord` — `id`, `ownerId`, `provider`, `canonicalUrl`,
  `mimeType`, `quality`, `checksum`, `fileId`, `messageId`, `chatId`
- `CreateMediaRequest` / `CreateMediaResponse` — same as `MediaRecord`
- `SyncMediaResponse` — `id`, `status`
- `ErrorResponse` — `error`, `error.code`, `error.message`

When the Drive adds a new field, append it to the schema list. When it
removes a field, do NOT remove it from the list — that would silently
break older Drives. Instead, mark it optional in the TypeScript interface
and remove it from the required list in a follow-up major version.

## Compatibility checker output

```
/drive
status: ok
version: 3.2.1
api: v1
compatible: ^3.0.0
✅ GET /api/v1/integration/health: status=ok
✅ GET /api/v1/integration/version: version=3.2.1
✅ schema HealthResponse: all required fields present
✅ schema VersionResponse: all required fields present
✅ GET /api/v1/media/:id: status=404 (404 is acceptable for a probe)
• POST /api/v1/media: mutating endpoint; covered by integration tests
```

The status is one of:

- `ok` — every probe passed and the version is in range.
- `degraded` — the Drive responded but with warnings (notes are listed).
- `incompatible` — the Drive is reachable but its version is outside the
  compatible range, or a GET endpoint returned an unexpected status.
- `unreachable` — the health endpoint did not respond.

## Contract evolution

Stage 2.9 does NOT change the contract. Stage 4.0 adds the
folder/share/trash/favorite/recent/collaboration endpoint surface that
telegram-drive finalised in Stage 3.x. When the upstream Drive evolves:

1. Bump `DRIVE_COMPATIBLE_RANGE` in `DriveBridgeContract.ts` to cover the
   new version.
2. Add the new endpoint + schema to `DriveContractSpec` /
   `DriveSchemas` / the TypeScript interfaces.
3. Extend `MockDriveServer` to implement the new endpoint and its
   failure modes.
4. Add an integration test that drives the new endpoint.
5. Run `npm run typecheck && npm run lint && npm test && npm run build`.
6. Update this document and `docs/INTEGRATION_TEST.md`.

## Stage 4.0 endpoints

Stage 4.0 wires the downloader into the full Drive Bridge surface. Every
call goes through `DriveApiClient` (the sole client) and the
`DriveSyncService` orchestrates the post-upload and post-download flows.

### `POST /api/v1/folders`

Authenticated, idempotent. Creates or upserts a folder. Request body is
`CreateFolderRequest`; response is `CreateFolderResponse` (`FolderRecord`).

```json
{ "id": "tmd-1", "ownerId": 1, "name": "Telegram Media Downloader", "parentId": null }
```

Statuses: `201`, `200`, `401`, `403`, `409`, `422`, `429`, `500`.

### `GET /api/v1/folders/:id`

Authenticated. Returns the stored `FolderRecord`.

Statuses: `200`, `401`, `403`, `404`, `500`.

### `POST /api/v1/folders/:id/media`

Authenticated, idempotent. Adds a media record to a folder. Request body
is `AddMediaToFolderRequest`.

Statuses: `201`, `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

### `POST /api/v1/share/:id`

Authenticated, idempotent. Creates a share link for a media record.
Request body is `CreateShareRequest`; response is `CreateShareResponse`
(`ShareRecord`).

Statuses: `201`, `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

### `GET /api/v1/trash`

Authenticated. Lists trashed items for an owner. Query: `?ownerId=<n>`.

Statuses: `200`, `401`, `403`, `500`.

### `DELETE /api/v1/trash/:id`

Authenticated, idempotent. Restores or permanently deletes a trashed
item. Returns `204 No Content` on success.

Statuses: `204`, `401`, `403`, `404`, `409`, `500`.

### `POST /api/v1/favorites`

Authenticated, idempotent. Marks a media record as favorite. Request
body is `FavoriteRequest`; response is `FavoriteResponse`
(`FavoriteRecord`).

Statuses: `201`, `200`, `401`, `403`, `409`, `422`, `429`, `500`.

### `DELETE /api/v1/favorites/:id`

Authenticated, idempotent. Removes a favorite. Returns `204 No Content`.

Statuses: `204`, `401`, `403`, `404`, `500`.

### `POST /api/v1/recent`

Authenticated, idempotent. Records a media access for the recent list.
Request body is `RecentRequest`; response is `RecentResponse`
(`RecentRecord`). The Drive upserts by `(mediaId, ownerId)`.

Statuses: `201`, `200`, `401`, `403`, `422`, `429`, `500`.

### `POST /api/v1/collaboration/:id/invite`

Authenticated, idempotent. Invites a collaborator to a folder. Request
body is `CollaborationInviteRequest`; response is
`CollaborationInviteResponse` (`CollaborationInvite`).

Statuses: `201`, `200`, `401`, `403`, `404`, `409`, `422`, `429`, `500`.

## Stage 4.0 retry policy

The `DriveSyncService` applies the retry policy defined in
`DriveSyncPolicy.ts`:

| Status | Decision | Backoff |
| --- | --- | --- |
| 401 / 403 / 422 / 404 / 409 | permanent (no retry) | — |
| 429 | retry | exponential (1s, 2s, 4s … capped at 60s) |
| 500 / 502 / 503 / 504 | retry | exponential backoff |
| 0 (network failure) | retry | exponential backoff |
| -1 (timeout) | retry | exponential backoff |

The retry budget is `DRIVE_SYNC_MAX_ATTEMPTS` (default 3), separate from
the queue worker's retry budget because Drive sync is best-effort. When
retries are exhausted the sync is counted as `drive_sync_dead`.

## Stage 4.0 sync flow

```
upload Telegram succeeds
  → POST /media               (createMedia)        [required]
  → POST /folders              (createFolder)       [best-effort]
  → POST /folders/:id/media   (addMediaToFolder)   [best-effort]
  → POST /media/:id/sync       (syncMedia)          [best-effort]

download completes (or cache hit)
  → POST /recent               (recordRecent)       [required]
  → POST /favorites            (addFavorite)        [only if favorite flag]
```

Every step is fire-and-forget from the pipeline's perspective: a failed
sync is logged and counted but the download itself is reported as
successful to the user. The downloader never blocks on the Drive and
never fails a download because the Drive is offline.

## Stage 4.1 — full per-service operations

Stage 4.1 wires every telegram-drive feature so the downloader can manage
the full Drive surface through the API Bridge. Every operation goes
through `DriveApiClient` (the sole client) and `DriveSyncService`
(asynchronous, retry-aware, per-service metrics).

### Folder operations

| Operation | Method | Path | Idempotent |
| --- | --- | --- | --- |
| create | POST | `/api/v1/folders` | yes |
| get | GET | `/api/v1/folders/:id` | no |
| rename | POST | `/api/v1/folders/:id/rename` | yes |
| move | POST | `/api/v1/folders/:id/move` | yes |
| delete | DELETE | `/api/v1/folders/:id` | yes |
| list | GET | `/api/v1/folders?ownerId=&parentId=` | no |
| add media | POST | `/api/v1/folders/:id/media` | yes |

### Share operations

| Operation | Method | Path | Idempotent |
| --- | --- | --- | --- |
| create | POST | `/api/v1/share/:mediaId` | yes |
| update | POST | `/api/v1/share/:id/update` | yes |
| revoke | DELETE | `/api/v1/share/:id` | yes |
| list | GET | `/api/v1/share/list?ownerId=&mediaId=` | no |

### Trash operations

| Operation | Method | Path | Idempotent |
| --- | --- | --- | --- |
| move to trash | POST | `/api/v1/trash` | yes |
| restore | POST | `/api/v1/trash/:id/restore` | yes |
| permanent delete | DELETE | `/api/v1/trash/:id` | yes |
| list | GET | `/api/v1/trash?ownerId=` | no |

### Favorite operations

| Operation | Method | Path | Idempotent |
| --- | --- | --- | --- |
| add | POST | `/api/v1/favorites` | yes |
| remove | DELETE | `/api/v1/favorites/:id` | yes |
| list | GET | `/api/v1/favorites?ownerId=` | no |

### Recent operations

| Operation | Method | Path | Idempotent |
| --- | --- | --- | --- |
| record access | POST | `/api/v1/recent` | yes |
| auto cleanup | POST | `/api/v1/recent/cleanup` | yes |

### Collaboration operations

| Operation | Method | Path | Idempotent |
| --- | --- | --- | --- |
| invite | POST | `/api/v1/collaboration/:folderId/invite` | yes |
| update permission | POST | `/api/v1/collaboration/:id` | yes |
| remove | DELETE | `/api/v1/collaboration/:id` | yes |
| list | GET | `/api/v1/collaboration/:folderId` | no |

### Per-service metrics

`/metrics` now reports per-service success/failed/retry counters:

```
Per-service sync:
  folder         success=3 failed=0 retry=0
  share          success=1 failed=0 retry=0
  trash          success=2 failed=0 retry=0
  favorite       success=1 failed=0 retry=0
  recent         success=5 failed=0 retry=0
  collaboration  success=1 failed=0 retry=0
```
