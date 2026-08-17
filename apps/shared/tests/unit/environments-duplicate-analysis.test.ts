import { describe, expect, it } from 'bun:test';
import {
  analyzeRuntimeScan,
  NODE_RUNTIME_DEFINITION,
} from '@mangostudio/shared/environments/detection';

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
      severity: 'info',
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

  it('does not report shadowing when both PATH entries hold the same version', () => {
    const status = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      {
        installations: [
          {
            path: '/usr/bin/node',
            rawPath: '/usr/bin/node',
            version: 'v22.13.0',
            origin: 'path',
            pathIndex: 0,
            effective: true,
          },
          {
            path: '/usr/local/bin/node',
            rawPath: '/usr/local/bin/node',
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

    expect(status.findings).toEqual([]);
    expect(status.health).toBe('ok');
  });

  it('warns when a runtime is installed only outside PATH', () => {
    const status = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      {
        installations: [
          {
            path: '/opt/node/bin/node',
            rawPath: '/opt/node/bin/node',
            version: 'v22.13.0',
            origin: 'well-known',
            effective: false,
          },
        ],
        failures: [],
      },
      { installable: false, probedAtMs: 1_700_000_000_000 }
    );

    expect(status.health).toBe('warn');
    expect(status.effective).toBeUndefined();
    expect(status.findings).toContainEqual({
      code: 'installed-but-not-on-path',
      params: { runtime: 'node', path: '/opt/node/bin/node' },
    });
  });

  it('distinguishes a missing runtime from failed executable probes', () => {
    const missing = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      { installations: [], failures: [] },
      { installable: false, probedAtMs: 1_700_000_000_000 }
    );

    expect(missing).toMatchObject({
      health: 'missing',
      findings: [{ code: 'not-found', params: { runtime: 'node' } }],
    });
  });

  it('reports a missing runtime alongside a broken candidate rather than hiding it', () => {
    // A dead shim on PATH used to suppress `not-found` entirely, so a user with
    // no real Node install only ever heard about the broken shim.
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

    expect(failed.health).toBe('error');
    expect(failed.findings).toEqual([
      { code: 'not-executable', params: { path: '/broken/bin/node' } },
      { code: 'probe-timeout', params: { path: '/stalled/bin/node' } },
      { code: 'not-found', params: { runtime: 'node' } },
    ]);
  });

  it('only escalates health for the effective installation being below minimum', () => {
    // A normal version-manager setup: three Node installs, the one that
    // actually runs is current, an older one sits below the floor. That old
    // install is still worth listing, but it must not turn the panel to warn.
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
            path: '/home/tester/.nvm/versions/node/v18.20.0/bin/node',
            rawPath: '/home/tester/.nvm/versions/node/v18.20.0/bin/node',
            version: 'v18.20.0',
            origin: 'well-known',
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

    expect(status.health).toBe('ok');
    expect(status.findings).toContainEqual({
      code: 'version-below-minimum',
      params: {
        path: '/home/tester/.nvm/versions/node/v18.20.0/bin/node',
        version: 'v18.20.0',
        minimumVersion: '22.13',
      },
      severity: 'info',
    });
  });

  it('keeps an executed-but-unparseable version as an installation, not a dropped candidate', () => {
    const status = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      {
        installations: [
          {
            path: '/usr/local/bin/node',
            rawPath: '/usr/local/bin/node',
            version: null,
            origin: 'path',
            pathIndex: 0,
            effective: true,
          },
        ],
        failures: [],
      },
      { installable: false, probedAtMs: 1_700_000_000_000 }
    );

    expect(status.health).toBe('warn');
    expect(status.effective?.version).toBeNull();
    expect(status.findings).toContainEqual({
      code: 'version-probe-failed',
      params: { path: '/usr/local/bin/node' },
    });
  });

  it('reports a consumer minimum against the consumer, and only warns while enabled', () => {
    const effectiveInstallation = {
      path: '/usr/local/bin/node',
      rawPath: '/usr/local/bin/node',
      version: 'v20.11.0',
      origin: 'path' as const,
      pathIndex: 0,
      effective: true,
    };
    const requirement = { consumer: 'cursor', major: 22, minor: 13, enabled: false };

    const disabled = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      { installations: [effectiveInstallation], failures: [] },
      {
        installable: false,
        probedAtMs: 1_700_000_000_000,
        consumerRequirements: [requirement],
      }
    );
    const enabled = analyzeRuntimeScan(
      NODE_RUNTIME_DEFINITION,
      { installations: [effectiveInstallation], failures: [] },
      {
        installable: false,
        probedAtMs: 1_700_000_000_000,
        consumerRequirements: [{ ...requirement, enabled: true }],
      }
    );

    expect(disabled.health).toBe('ok');
    expect(disabled.findings).toContainEqual({
      code: 'version-below-minimum-for',
      params: { consumer: 'cursor', version: 'v20.11.0', minimumVersion: '22.13' },
      severity: 'info',
    });
    expect(enabled.health).toBe('warn');
    expect(enabled.findings).toContainEqual({
      code: 'version-below-minimum-for',
      params: { consumer: 'cursor', version: 'v20.11.0', minimumVersion: '22.13' },
    });
  });
});
