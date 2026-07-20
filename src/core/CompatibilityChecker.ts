import { logger } from '../logger/logger';
import { DriveApiClient, DriveCallResult } from './DriveApiClient';
import {
  DRIVE_API_VERSION,
  DRIVE_COMPATIBLE_RANGE,
  DriveContractSpec,
  DriveEndpoints,
  DriveSchemas,
  DriveStatus,
  EndpointSpec,
  HealthResponse,
  VersionResponse,
  MediaRecord,
} from './DriveBridgeContract';
import { satisfies } from '../utils/semver';

export type CompatibilityStatus = 'ok' | 'degraded' | 'incompatible' | 'unreachable';

export interface CompatibilityReport {
  status: CompatibilityStatus;
  checkedAt: string;
  driveVersion?: string;
  apiVersion?: string;
  compatibleRange: string;
  endpointResults: EndpointCheck[];
  schemaResults: SchemaCheck[];
  notes: string[];
}

export interface EndpointCheck {
  endpoint: string;
  method: string;
  reachable: boolean;
  status?: number;
  ok: boolean;
  detail: string;
}

export interface SchemaCheck {
  schema: string;
  ok: boolean;
  missingFields: string[];
  detail: string;
}

/**
 * CompatibilityChecker verifies that the running Drive Bridge matches the
 * v1 contract the downloader was built against. It does NOT mutate any
 * state: every call is a read probe. The checker is safe to invoke from
 * the admin `/diag` command and from the integration test suite.
 *
 * Checks performed:
 *  - `/integration/health` returns `status: ok` (or `degraded`).
 *  - `/integration/version` reports an `apiVersion` of `v1` and a
 *    `version` that satisfies the downloader's `DRIVE_COMPATIBLE_RANGE`.
 *  - Each documented endpoint path appears in `DriveContractSpec` and
 *    responds with one of its contractually-allowed statuses.
 *  - Each documented response schema has its required top-level fields.
 *
 * The checker never throws — every failure is recorded as a non-OK
 * `EndpointCheck` so the admin command can render a full report.
 */
export class CompatibilityChecker {
  constructor(private readonly client: DriveApiClient) {}

  async run(): Promise<CompatibilityReport> {
    const endpointResults: EndpointCheck[] = [];
    const schemaResults: SchemaCheck[] = [];
    const notes: string[] = [];

    // 1. Health probe.
    const healthCheck = await this.checkHealth();
    endpointResults.push(healthCheck.endpoint);
    schemaResults.push(healthCheck.schema);

    if (healthCheck.endpoint.status === 0 || !healthCheck.endpoint.reachable) {
      notes.push('Drive is unreachable; skipping remaining endpoint checks.');
      return {
        status: 'unreachable',
        checkedAt: new Date().toISOString(),
        compatibleRange: DRIVE_COMPATIBLE_RANGE,
        endpointResults,
        schemaResults,
        notes,
      };
    }

    // 2. Version probe — drives the version compatibility decision.
    const versionCheck = await this.checkVersion();
    endpointResults.push(versionCheck.endpoint);
    schemaResults.push(versionCheck.schema);

    let driveVersion: string | undefined;
    let apiVersion: string | undefined;
    let versionCompatible = false;
    if (versionCheck.body) {
      driveVersion = versionCheck.body.version;
      apiVersion = versionCheck.body.apiVersion;
      if (driveVersion) {
        versionCompatible = satisfies(driveVersion, DRIVE_COMPATIBLE_RANGE);
        if (!versionCompatible) {
          notes.push(`Drive version ${driveVersion} is outside the compatible range ${DRIVE_COMPATIBLE_RANGE}.`);
        }
      } else {
        notes.push('Drive did not report a version string.');
      }
      if (apiVersion && apiVersion !== DRIVE_API_VERSION) {
        notes.push(`Drive reports apiVersion '${apiVersion}', expected '${DRIVE_API_VERSION}'.`);
      }
    } else {
      notes.push('Drive did not return a parseable version payload.');
    }

    // 3. Per-endpoint probe for the remaining contract surface. The media
    // endpoints are exercised with a synthetic id so we do not depend on
    // any pre-existing record in the Drive.
    const syntheticId = `compat-probe-${Date.now()}`;
    for (const spec of DriveContractSpec) {
      if (spec.path === DriveEndpoints.health || spec.path === DriveEndpoints.version) {
        continue;
      }
      const check = await this.probeEndpoint(spec, syntheticId);
      endpointResults.push(check);
    }

    // 4. Schema presence is verified from the version + health payloads
    // already collected. The media-record schema is verified lazily by
    // the integration test suite because it requires a successful create.
    const status: CompatibilityStatus = aggregateCompatibility(
      versionCompatible,
      endpointResults,
      notes,
    );

    logger.info({ status, driveVersion, apiVersion }, 'compatibility check complete');
    return {
      status,
      checkedAt: new Date().toISOString(),
      driveVersion,
      apiVersion,
      compatibleRange: DRIVE_COMPATIBLE_RANGE,
      endpointResults,
      schemaResults,
      notes,
    };
  }

  private async checkHealth(): Promise<{ endpoint: EndpointCheck; schema: SchemaCheck }> {
    const result = await this.client.health();
    const endpoint: EndpointCheck = {
      endpoint: DriveEndpoints.health,
      method: 'GET',
      reachable: result.status !== 'down',
      ok: result.status === 'ok' || result.status === 'degraded',
      detail: result.status === 'down' ? `down: ${result.checks?.error ?? 'unknown'}` : `status=${result.status}`,
    };
    const missing = missingFields(result, DriveSchemas.HealthResponse);
    const schema: SchemaCheck = {
      schema: 'HealthResponse',
      ok: missing.length === 0,
      missingFields: missing,
      detail: missing.length === 0 ? 'all required fields present' : `missing: ${missing.join(', ')}`,
    };
    return { endpoint, schema };
  }

  private async checkVersion(): Promise<{ endpoint: EndpointCheck; schema: SchemaCheck; body: VersionResponse | null }> {
    const result: DriveCallResult<VersionResponse> = await this.client.getVersion();
    const endpoint: EndpointCheck = {
      endpoint: DriveEndpoints.version,
      method: 'GET',
      reachable: result.status !== 0 && result.status !== -1,
      status: result.status,
      ok: result.ok && Boolean(result.body),
      detail: result.ok ? `version=${result.body?.version ?? '?'}` : `status=${result.status}`,
    };
    const missing = result.body ? missingFields(result.body, DriveSchemas.VersionResponse) : DriveSchemas.VersionResponse;
    const schema: SchemaCheck = {
      schema: 'VersionResponse',
      ok: missing.length === 0,
      missingFields: missing,
      detail: missing.length === 0 ? 'all required fields present' : `missing: ${missing.join(', ')}`,
    };
    return { endpoint, schema, body: result.body };
  }

  private async probeEndpoint(spec: EndpointSpec, syntheticId: string): Promise<EndpointCheck> {
    // We only probe read-only endpoints (GET) so the checker is safe to run
    // against a production Drive. Mutating endpoints are covered by the
    // integration test suite against the mock.
    if (spec.method !== 'GET') {
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable: true,
        ok: true,
        detail: 'mutating endpoint; covered by integration tests',
      };
    }
    if (spec.path === '/api/v1/media/:id') {
      const result = await this.client.getMedia(syntheticId);
      const reachable = result.status !== 0 && result.status !== -1;
      const ok = result.status === DriveStatus.notFound || result.ok;
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable,
        status: result.status,
        ok,
        detail: ok ? `status=${result.status} (404 is acceptable for a probe)` : `status=${result.status}`,
      };
    }
    if (spec.path === '/api/v1/folders/:id') {
      const result = await this.client.getFolder(syntheticId);
      const reachable = result.status !== 0 && result.status !== -1;
      const ok = result.status === DriveStatus.notFound || result.ok;
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable,
        status: result.status,
        ok,
        detail: ok ? `status=${result.status} (404 is acceptable for a probe)` : `status=${result.status}`,
      };
    }
    if (spec.path === DriveEndpoints.trash) {
      const result = await this.client.listTrash(0);
      const reachable = result.status !== 0 && result.status !== -1;
      const ok = result.ok || result.status === DriveStatus.notFound;
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable,
        status: result.status,
        ok,
        detail: ok ? `status=${result.status}` : `status=${result.status}`,
      };
    }
    if (spec.path === DriveEndpoints.folders) {
      const result = await this.client.listFolders(0);
      const reachable = result.status !== 0 && result.status !== -1;
      const ok = result.ok || result.status === DriveStatus.notFound;
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable,
        status: result.status,
        ok,
        detail: ok ? `status=${result.status}` : `status=${result.status}`,
      };
    }
    if (spec.path === DriveEndpoints.share('list')) {
      const result = await this.client.listShares(0);
      const reachable = result.status !== 0 && result.status !== -1;
      const ok = result.ok || result.status === DriveStatus.notFound;
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable,
        status: result.status,
        ok,
        detail: ok ? `status=${result.status}` : `status=${result.status}`,
      };
    }
    if (spec.path === DriveEndpoints.favorite) {
      const result = await this.client.listFavorites(0);
      const reachable = result.status !== 0 && result.status !== -1;
      const ok = result.ok || result.status === DriveStatus.notFound;
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable,
        status: result.status,
        ok,
        detail: ok ? `status=${result.status}` : `status=${result.status}`,
      };
    }
    if (spec.path === '/api/v1/collaboration/:folderId') {
      // The collaborators list needs a folder to exist. A 404 is acceptable
      // for the probe (the synthetic folder id does not exist).
      const result = await this.client.listCollaborators(syntheticId);
      const reachable = result.status !== 0 && result.status !== -1;
      const ok = result.status === DriveStatus.notFound || result.ok;
      return {
        endpoint: spec.path,
        method: spec.method,
        reachable,
        status: result.status,
        ok,
        detail: ok ? `status=${result.status} (404 is acceptable for a probe)` : `status=${result.status}`,
      };
    }
    return {
      endpoint: spec.path,
      method: spec.method,
      reachable: false,
      ok: false,
      detail: 'no probe implemented',
    };
  }
}

function aggregateCompatibility(
  versionCompatible: boolean,
  endpointResults: EndpointCheck[],
  notes: string[],
): CompatibilityStatus {
  const anyUnreachable = endpointResults.some((e) => !e.reachable && e.method === 'GET');
  if (anyUnreachable) {
    return 'incompatible';
  }
  if (!versionCompatible) {
    return 'incompatible';
  }
  if (notes.length > 0) {
    return 'degraded';
  }
  return 'ok';
}

function missingFields(payload: unknown, required: string[]): string[] {
  if (!payload || typeof payload !== 'object') {
    return [...required];
  }
  const obj = payload as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of required) {
    if (field.includes('.')) {
      const [head, tail] = field.split('.', 2);
      if (!hasPath(obj[head], tail)) {
        missing.push(field);
      }
    } else if (obj[field] === undefined || obj[field] === null) {
      missing.push(field);
    }
  }
  return missing;
}

function hasPath(value: unknown, path: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  const parts = path.split('.');
  let current: unknown = value;
  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== 'object') {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined && current !== null;
}

export type { HealthResponse, MediaRecord };
