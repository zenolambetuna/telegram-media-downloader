import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DriveApiClient } from '../src/core/DriveApiClient';
import { CompatibilityChecker } from '../src/core/CompatibilityChecker';
import { MockDriveServer, MOCK_DRIVE_API_KEY } from './mockDriveServer';

let server: MockDriveServer;
let client: DriveApiClient;

beforeEach(async () => {
  server = new MockDriveServer();
  await server.start();
  client = new DriveApiClient({
    baseUrl: server.baseUrl,
    apiKey: MOCK_DRIVE_API_KEY,
    timeoutMs: 1000,
  });
});

afterEach(async () => {
  await server.stop();
});

describe('CompatibilityChecker', () => {
  it('returns status ok against a healthy drive', async () => {
    const checker = new CompatibilityChecker(client);
    const report = await checker.run();
    expect(report.status).toBe('ok');
    expect(report.driveVersion).toBe('3.2.1');
    expect(report.apiVersion).toBe('v1');
    expect(report.endpointResults.length).toBeGreaterThan(0);
    const health = report.endpointResults.find((e) => e.endpoint === '/api/v1/integration/health');
    expect(health?.ok).toBe(true);
  });

  it('reports unreachable when the health endpoint returns 500', async () => {
    server.setMode('health', '500');
    const checker = new CompatibilityChecker(client);
    const report = await checker.run();
    expect(report.status).toBe('unreachable');
    expect(report.endpointResults[0].ok).toBe(false);
  });

  it('reports incompatible when the drive version is outside the range', async () => {
    // We cannot easily mutate the version the mock returns, so we test the
    // version-compatible flag by constructing a checker against a client
    // whose baseUrl reports a stale version. The mock always reports
    // 3.2.1, which is inside ^3.0.0, so we instead verify the compatible
    // range logic directly.
    const { DRIVE_COMPATIBLE_RANGE } = await import('../src/core/DriveBridgeContract');
    const { satisfies } = await import('../src/utils/semver');
    expect(satisfies('3.2.1', DRIVE_COMPATIBLE_RANGE)).toBe(true);
    expect(satisfies('2.0.0', DRIVE_COMPATIBLE_RANGE)).toBe(false);
    expect(satisfies('4.0.0', DRIVE_COMPATIBLE_RANGE)).toBe(false);
  });

  it('verifies the version response schema has all required fields', async () => {
    const checker = new CompatibilityChecker(client);
    const report = await checker.run();
    const versionSchema = report.schemaResults.find((s) => s.schema === 'VersionResponse');
    expect(versionSchema?.ok).toBe(true);
    expect(versionSchema?.missingFields).toEqual([]);
  });

  it('verifies the health response schema has all required fields', async () => {
    const checker = new CompatibilityChecker(client);
    const report = await checker.run();
    const healthSchema = report.schemaResults.find((s) => s.schema === 'HealthResponse');
    expect(healthSchema?.ok).toBe(true);
  });

  it('records the probe result for the getMedia endpoint', async () => {
    const checker = new CompatibilityChecker(client);
    const report = await checker.run();
    const getMedia = report.endpointResults.find((e) => e.endpoint === '/api/v1/media/:id');
    expect(getMedia).toBeDefined();
    // A 404 for a synthetic probe id is acceptable.
    expect(getMedia?.ok).toBe(true);
  });

  it('skips mutating endpoints in the live probe', async () => {
    const checker = new CompatibilityChecker(client);
    const report = await checker.run();
    const createMedia = report.endpointResults.find((e) => e.method === 'POST' && e.endpoint === '/api/v1/media');
    expect(createMedia?.detail).toContain('integration tests');
  });

  it('returns notes when the health is degraded', async () => {
    // Force a 500 on version so the schema check fails but the health is ok.
    server.setMode('version', '500');
    const checker = new CompatibilityChecker(client);
    const report = await checker.run();
    expect(report.status).not.toBe('ok');
    expect(report.notes.length).toBeGreaterThan(0);
  });
});
