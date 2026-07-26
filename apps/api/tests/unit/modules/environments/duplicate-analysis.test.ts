import { describe, expect, it } from 'bun:test';
import { analyzeRuntimeScan } from '../../../../src/modules/environments/domain/duplicate-analysis';
import { NODE_RUNTIME_DEFINITION } from '../../../../src/modules/environments/domain/runtime-definitions';

describe('analyzeRuntimeScan', () => {
  it('does not report an alias as a duplicate installation', () => {
    const status = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      {
        installations: [
          {
            path: '/home/tester/.nvm/versions/node/v22.13.0/bin/node',
            rawPath: '/usr/local/bin/node',
            version: 'v22.13.0',
            origin: 'path',
            pathIndex: 0,
            effective: true,
          },
          {
            path: '/home/tester/.nvm/versions/node/v22.13.0/bin/node',
            rawPath: '/home/tester/.nvm/current/bin/node',
            version: 'v22.13.0',
            origin: 'version-manager',
            pathIndex: 1,
            effective: false,
            aliasOf: '/usr/local/bin/node',
            managedBy: 'nvm',
          },
        ],
        failures: [],
      },
      { installable: false, probedAtMs: 1_700_000_000_000 }
    );

    expect(status.health).toBe('ok');
    expect(status.installations).toHaveLength(2);
    expect(status.findings).toEqual([]);
    expect(status.effective?.rawPath).toBe('/usr/local/bin/node');
  });

  it('explains version conflicts and PATH shadowing with actionable params', () => {
    const status = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      {
        installations: [
          {
            path: '/old/bin/node',
            rawPath: '/old/bin/node',
            version: 'v20.11.0',
            origin: 'path',
            pathIndex: 0,
            effective: true,
          },
          {
            path: '/new/bin/node',
            rawPath: '/new/bin/node',
            version: 'v22.13.0',
            origin: 'path',
            pathIndex: 1,
            effective: false,
          },
        ],
        failures: [],
      },
      {
        installable: false,
        probedAtMs: 1_700_000_000_000,
        minimumVersion: { major: 22, minor: 13 },
      }
    );

    expect(status.health).toBe('warn');
    expect(status.findings).toContainEqual({
      code: 'multiple-versions',
      params: { runtime: 'node', versions: 'v20.11.0, v22.13.0' },
    });
    expect(status.findings).toContainEqual({
      code: 'shadowed-by-earlier-path',
      params: {
        effectivePath: '/old/bin/node',
        effectivePathIndex: '0',
        shadowedPath: '/new/bin/node',
        shadowedPathIndex: '1',
      },
    });
    expect(status.findings).toContainEqual({
      code: 'version-below-minimum',
      params: {
        path: '/old/bin/node',
        version: 'v20.11.0',
        minimumVersion: '22.13',
      },
    });
  });

  it('distinguishes a missing runtime from failed executable probes', () => {
    const missing = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      { installations: [], failures: [] },
      { installable: false, probedAtMs: 1_700_000_000_000 }
    );
    const failed = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      {
        installations: [],
        failures: [
          { code: 'not-executable', path: '/broken/bin/node' },
          { code: 'probe-timeout', path: '/stalled/bin/node' },
        ],
      },
      { installable: false, probedAtMs: 1_700_000_000_000 }
    );

    expect(missing).toMatchObject({
      health: 'missing',
      findings: [{ code: 'not-found', params: { runtime: 'node' } }],
    });
    expect(failed.health).toBe('error');
    expect(failed.findings).toEqual([
      { code: 'not-executable', params: { path: '/broken/bin/node' } },
      { code: 'probe-timeout', params: { path: '/stalled/bin/node' } },
    ]);
  });
});
