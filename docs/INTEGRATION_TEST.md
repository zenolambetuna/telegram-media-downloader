# Integration Test & Compatibility Guide (Stage 2.9 / Stage 4.0)

Stage 2.9 makes the Telegram Media Downloader verifiably ready to talk to
the Telegram Drive Bridge API. It adds three pieces:

1. **A documented v1 Bridge contract** (`src/core/DriveBridgeContract.ts`)
   that captures the endpoint surface, schemas, authentication, and
   idempotency rules the Drive team finalised in Stages 2.0-2.7.
2. **A mock Drive server** (`tests/mockDriveServer.ts`) that implements
   the contract in-process, with per-endpoint failure injection.
3. **An integration test suite** (`tests/driveApiIntegration.test.ts`) +
   **a compatibility checker** (`src/core/CompatibilityChecker.ts`) that
   drive the mock and verify the contract end-to-end.

The Bridge contract itself is owned by the upstream Drive service and is
NOT changed by Stage 2.9. The downloader's runtime download flow still
talks to Telegram directly; the Bridge client methods added in
`DriveApiClient` are for diagnostics, compatibility verification, and
future stages — they are not wired into the pipeline.

## Running the integration tests

```bash
# Set the env vars the config schema requires, then run vitest.
BOT_TOKEN=x CHANNEL_ID=-100 ADMIN_ID=1 npm test

# Run only the Drive integration suite.
BOT_TOKEN=x CHANNEL_ID=-100 ADMIN_ID=1 npm test -- --run driveApiIntegration

# Run the compatibility checker tests.
BOT_TOKEN=x CHANNEL_ID=-100 ADMIN_ID=1 npm test -- --run compatibilityChecker
```

The integration tests start the mock server on a random loopback port
(`127.0.0.1:PORT`) per test, so they never collide and need no external
Drive instance. Every test cleans up its server in `afterEach`.

## Test coverage

`tests/driveApiIntegration.test.ts` covers every behaviour listed in the
Stage 2.9 brief:

| Behaviour | Test name |
| --- | --- |
| All endpoints | `full CRUD round trip` |
| Authentication | `rejects requests without an API key with 401`, `rejects requests with the wrong API key`, `accepts requests with the correct API key`, `401/403 on create` |
| Idempotency | `returns the same response for repeated requests with the same key`, `creates separate records for different idempotency keys`, `treats delete as idempotent`, `treats sync as idempotent` |
| Retry classification | `classifies 429 as a retryable rate limit`, `classifies 500 as a retryable server error`, `classifies 409 as a permanent conflict`, `does not retry a 404 from getMedia` |
| Timeout | `returns status -1 when the server never responds`, `times out faster than the configured deadline` |
| Invalid payload | `returns 422 when the create payload is invalid`, `returns 422 when the create endpoint is forced to 422` |
| Duplicate request | `returns the cached response for an identical idempotency key`, `records both requests in the server request log` |
| Network failure | `returns status 0 when the server destroys the socket`, `reports down for an unreachable baseUrl` |
| Failure modes | `401, 403, 404, 409, 422, 429, 500` per endpoint |
| Version compatibility | `reports a version that satisfies the downloader compatible range` |
| Request headers | `sends Authorization, Idempotency-Key, Accept, Content-Type`, `sends the X-Api-Version and X-Client headers` |
| Unconfigured client | `returns status 0 from every method when not configured`, `reports health as down when not configured` |

`tests/compatibilityChecker.test.ts` covers the checker:

- `status ok against a healthy drive`
- `unreachable when the health endpoint returns 500`
- `incompatible when the drive version is outside the range`
- `verifies VersionResponse / HealthResponse schemas`
- `records the probe result for the getMedia endpoint`
- `skips mutating endpoints in the live probe`
- `returns notes when the health is degraded`

`tests/metricsCollector.test.ts` covers the new Stage 2.9 metrics
(success rate, retry rate, average sync time, drive availability gauge,
queue length).

## Mock Drive server

`tests/mockDriveServer.ts` is a single-file HTTP server built on Node's
`http` module — no new dependencies. It implements every endpoint in the
v1 contract:

| Endpoint | Method | Mode | Behaviour |
| --- | --- | --- | --- |
| `/api/v1/integration/health` | GET | success / 500 / timeout | Returns `HealthResponse` |
| `/api/v1/integration/version` | GET | success / 401 / 500 | Returns `VersionResponse` |
| `/api/v1/media` | POST | success / 401 / 403 / 409 / 422 / 429 / 500 / timeout / network | Validates `CreateMediaRequest`, dedupes by `Idempotency-Key` |
| `/api/v1/media/:id` | GET | success / 401 / 403 / 404 / 500 | Returns the stored `MediaRecord` |
| `/api/v1/media/:id` | DELETE | success / 401 / 403 / 404 / 409 / 500 | Idempotent delete |
| `/api/v1/media/:id/sync` | POST | success / 401 / 403 / 404 / 409 / 429 / 500 / timeout | Idempotent sync |

Usage:

```typescript
import { MockDriveServer, MOCK_DRIVE_API_KEY } from './mockDriveServer';

const server = new MockDriveServer();
await server.start();
const url = server.baseUrl;                  // http://127.0.0.1:PORT
server.setMode('createMedia', '429');        // inject a 429
server.setDelay(2000);                       // simulate a slow response
const requests = server.getRequests();       // inspect what was received
await server.stop();
```

The mock keeps an in-memory `media` table and an idempotency cache so the
duplicate-request behaviour of the real Bridge is reproduced faithfully.

## Live compatibility verification

The `CompatibilityChecker` is wired into two admin commands:

- `/drive` — runs the compatibility checker and prints the report.
- `/diag` — runs health + queue + metrics + drive compatibility in one.

Both call the real Drive (if `DRIVE_API_BASE_URL` + `DRIVE_API_KEY` are
set) or report `not configured` otherwise. The checker never mutates
state — every call is a read probe. Mutating endpoints (POST/DELETE) are
skipped in the live probe and only exercised against the mock.

## Adding new integration tests

When you extend the Bridge contract:

1. Add the endpoint + schema to `src/core/DriveBridgeContract.ts`
   (`DriveContractSpec`, `DriveSchemas`, response interfaces).
2. Add a handler in `tests/mockDriveServer.ts` that implements the
   endpoint and respects `setMode()`.
3. Add a test in `tests/driveApiIntegration.test.ts` that drives the
   client against the mock and asserts the contract.
4. If the endpoint is read-only, extend `probeEndpoint()` in
   `CompatibilityChecker.ts` so `/drive` includes it.
5. Run `npm run typecheck && npm run lint && npm test && npm run build`.

The contract is the single source of truth — the mock, the checker, and
the tests all derive from it.

## Stage 4.0 — end-to-end sync tests

Stage 4.0 wires the downloader into the full Drive Bridge surface. The
new test files cover the post-upload and post-download sync flows:

- `tests/driveSyncService.test.ts` (20 tests) — the `DriveSyncService`
  orchestrator: happy-path upload/download sync, retry policy
  (401/403/422 permanent; 429/5xx/network retry with backoff),
  non-blocking contract (sync is fire-and-forget), idempotency, and
  best-effort folder sync. Verifies that Drive offline does not break
  the download flow.
- `tests/driveApiEndpoints.test.ts` (15 tests) — the new
  `DriveApiClient` methods: folders, share, trash, favorites, recent,
  collaboration. Each endpoint is exercised against the mock with its
  success path and at least one failure mode.

Run them with:

```bash
BOT_TOKEN=x CHANNEL_ID=-100 ADMIN_ID=1 npm test -- --run driveSyncService
BOT_TOKEN=x CHANNEL_ID=-100 ADMIN_ID=1 npm test -- --run driveApiEndpoints
```

The mock server (`tests/mockDriveServer.ts`) implements every Stage 4.0
endpoint with per-endpoint failure injection (`setMode()`), an in-memory
media/folder/share/trash/favorite/recent/collaboration store, and an
idempotency cache that reproduces the real Bridge's duplicate-request
behaviour.

### End-to-end flow under test

```
upload Telegram succeeds
  → POST /media               (createMedia)        [required — failure aborts sync]
  → POST /folders              (createFolder)       [best-effort]
  → POST /folders/:id/media   (addMediaToFolder)   [best-effort]
  → POST /media/:id/sync       (syncMedia)          [best-effort]

download completes
  → POST /recent               (recordRecent)       [required — failure aborts sync]
  → POST /favorites            (addFavorite)        [only if favorite flag; best-effort]
```

The tests verify that:

1. A successful upload records `drive_sync_success` and the media
   appears in the mock's media store.
2. A failed required step (e.g. `createMedia` returns 401) records
   `drive_sync_failed` and does not retry (permanent).
3. A retryable failure (e.g. `createMedia` returns 500) retries with
   backoff and records `drive_sync_dead` when retries are exhausted.
4. The sync is fire-and-forget: `syncAfterUpload` / `syncAfterDownload`
   return in under 100ms even when the mock is slow.
5. Replaying a sync with the same `Idempotency-Key` returns the cached
   response (no duplicate media records).
6. A Drive offline (network failure) does not break the download flow —
   the sync is logged and counted but the download succeeds.
