import { describe, expect, it } from 'bun:test';
import {
  checkAuthSecret,
  checkConfig,
  checkDatabase,
  checkDir,
  checkFrontend,
  checkInstance,
  checkRuntime,
  checkRuntimeBinary,
  checkSshClient,
  collectCursorDoctorChecks,
  cursorRuntimeChainReady,
  type FsProbe,
} from '../../../src/cli/doctor-checks';
import type { MangoConfig } from '../../../src/lib/config';
import type { ServerState } from '../../../src/lib/server-state';

/** Named fake filesystem probe driven by explicit existing/writable path sets. */
class FakeFsProbe implements FsProbe {
  constructor(
    private readonly existing: Set<string>,
    private readonly writable: Set<string>
  ) {}

  exists(path: string): boolean {
    return this.existing.has(path);
  }

  isWritable(path: string): boolean {
    return this.writable.has(path);
  }
}

function makeConfig(overrides: Partial<MangoConfig> = {}): MangoConfig {
  return {
    server: { host: 'localhost', port: 3001, publicUrl: '' },
    frontend: { host: 'localhost', port: 5173 },
    database: { path: '/data/db.sqlite' },
    uploads: { dir: '/data/uploads' },
    images: { dir: '/data/images' },
    toolImages: { dir: '/data/tool-images' },
    agents: { dir: '/data/agents' },
    skills: { dir: '/data/skills' },
    library: {
      backupDir: '/data/library-backups',
      backupRetentionCount: 10,
      backupRetentionBytes: 1024,
    },
    checkpoints: { dir: '/data/checkpoints' },
    auth: { secret: 'x'.repeat(32), url: 'http://localhost:3001' },
    security: { trustProxy: false },
    environments: { ltsRefresh: false, installsEnabled: false, container: false },
    cursor: { workspaceDir: '', sidecarScriptPath: '', nodePath: '' },
    chatgpt: { authBaseUrl: 'https://auth.openai.com', apiBaseUrl: 'https://api.openai.com' },
    secretStore: { unsafeFileFallbackDir: '' },
    corsOrigins: [],
    configFilePath: '/data/config.toml',
    ...overrides,
  };
}

function makeState(): ServerState {
  return { pid: 42, port: 3001, host: 'localhost', startedAt: 0, logFile: '', version: 't' };
}

describe('checkDir', () => {
  it('passes when the directory exists and is writable', () => {
    const fs = new FakeFsProbe(new Set(['/data']), new Set(['/data']));
    expect(checkDir('Data', '/data', fs).status).toBe('ok');
  });

  it('fails when the directory exists but is not writable', () => {
    const fs = new FakeFsProbe(new Set(['/data']), new Set());
    expect(checkDir('Data', '/data', fs).status).toBe('fail');
  });

  it('passes when missing but the parent is writable', () => {
    const fs = new FakeFsProbe(new Set(['/data']), new Set(['/data']));
    const result = checkDir('Logs', '/data/logs', fs);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('will be created');
  });

  it('passes when several levels are missing but an ancestor is writable', () => {
    // Fresh install: ~/.mango and ~/.mango/logs do not exist yet, but ~ does.
    const fs = new FakeFsProbe(new Set(['/home/user']), new Set(['/home/user']));
    const result = checkDir('Logs', '/home/user/.mango/logs', fs);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('will be created');
  });

  it('fails when no existing ancestor is writable', () => {
    const fs = new FakeFsProbe(new Set(['/home/user']), new Set());
    expect(checkDir('Logs', '/home/user/.mango/logs', fs).status).toBe('fail');
  });
});

describe('checkConfig', () => {
  it('reports the resolved host:port and config path', () => {
    const result = checkConfig(makeConfig());
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('localhost:3001');
    expect(result.detail).toContain('/data/config.toml');
  });
});

describe('checkDatabase', () => {
  it('passes for an in-memory database', () => {
    const result = checkDatabase(
      makeConfig({ database: { path: ':memory:' } }),
      new FakeFsProbe(new Set(), new Set())
    );
    expect(result.status).toBe('ok');
  });

  it('passes when the database directory is writable', () => {
    const fs = new FakeFsProbe(new Set(['/data']), new Set(['/data']));
    expect(checkDatabase(makeConfig(), fs).status).toBe('ok');
  });

  it('fails when the database directory is not usable', () => {
    const fs = new FakeFsProbe(new Set(), new Set());
    expect(checkDatabase(makeConfig(), fs).status).toBe('fail');
  });
});

describe('checkFrontend', () => {
  it('passes when index.html is present', () => {
    const fs = new FakeFsProbe(new Set(['/app', '/app/index.html']), new Set());
    expect(checkFrontend('/app', fs).status).toBe('ok');
  });

  it('warns when the frontend is missing', () => {
    const fs = new FakeFsProbe(new Set(['/app']), new Set());
    expect(checkFrontend('/app', fs).status).toBe('warn');
  });
});

describe('checkAuthSecret', () => {
  it('fails when unset', () => {
    const result = checkAuthSecret(makeConfig({ auth: { secret: '', url: '' } }));

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('BETTER_AUTH_SECRET is required');
  });

  it('fails when shorter than 32 characters', () => {
    const result = checkAuthSecret(makeConfig({ auth: { secret: 'short', url: '' } }));

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('at least 32 characters');
  });

  it('passes for a sufficiently long secret', () => {
    expect(checkAuthSecret(makeConfig()).status).toBe('ok');
  });
});

describe('checkInstance', () => {
  it('reports not running when there is no state', () => {
    const result = checkInstance(null, false);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('not running');
  });

  it('warns on a stale state file', () => {
    expect(checkInstance(makeState(), false).status).toBe('warn');
  });

  it('reports a running instance without probing health', () => {
    const result = checkInstance(makeState(), true);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('health not probed');
  });
});

describe('checkRuntime', () => {
  it('reports version, platform and mode', () => {
    const result = checkRuntime('1.2.3', true);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('v1.2.3');
    expect(result.detail).toContain('standalone');
  });
});

describe('checkRuntimeBinary', () => {
  const at = '/opt/mangostudio/mangostudio-runtime';

  it('treats a source checkout as fine: the launcher runs the workspace entry', () => {
    const result = checkRuntimeBinary(
      { path: null, present: false, version: null, error: null },
      '1.2.3'
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('source checkout');
  });

  it('warns rather than fails when the binary is missing, since Local still works', () => {
    const result = checkRuntimeBinary(
      { path: at, present: false, version: null, error: null },
      '1.2.3'
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(at);
    expect(result.detail).toContain('stdio environments');
  });

  it('warns when the binary and the hub come from different releases', () => {
    const result = checkRuntimeBinary(
      { path: at, present: true, version: '1.2.2', error: null },
      '1.2.3'
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('v1.2.2');
    expect(result.detail).toContain('v1.2.3');
  });

  it('warns when the binary cannot report a version at all', () => {
    const result = checkRuntimeBinary(
      { path: at, present: true, version: null, error: 'exited with code 126' },
      '1.2.3'
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('exited with code 126');
  });

  it('passes when the versions are locked together', () => {
    const result = checkRuntimeBinary(
      { path: at, present: true, version: '1.2.3', error: null },
      '1.2.3'
    );
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('v1.2.3');
  });
});

describe('checkSshClient', () => {
  it('warns rather than fails when there is no ssh, since only SSH environments need it', () => {
    const result = checkSshClient({ path: null, version: null, error: null });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('SSH environments');
  });

  it('warns when ssh is on PATH but answered nothing usable', () => {
    const result = checkSshClient({
      path: '/usr/bin/ssh',
      version: null,
      error: 'exited with code 1',
    });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('exited with code 1');
  });

  it('reports the client banner and where it came from', () => {
    const result = checkSshClient({
      path: '/usr/bin/ssh',
      version: 'OpenSSH_9.6p1, OpenSSL 3.0.13',
      error: null,
    });

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('OpenSSH_9.6p1');
    expect(result.detail).toContain('/usr/bin/ssh');
  });
});

describe('collectCursorDoctorChecks', () => {
  it('maps each healthy chain link to an ok row', () => {
    const results = collectCursorDoctorChecks([
      { link: 'node', ok: true, detail: '/usr/bin/node (v22.13.0, meets >= 22.13)' },
      { link: 'sidecar', ok: true, detail: '/app/cursor-sidecar/run-agent.mjs (present)' },
      { link: 'sdk', ok: true, detail: '@cursor/sdk complete' },
      { link: 'native', ok: true, detail: '@cursor/sdk-linux-x64 (present)' },
    ]);

    expect(results.map((row) => row.label)).toEqual([
      'Cursor Node',
      'Cursor sidecar',
      'Cursor SDK',
      'Cursor native',
    ]);
    expect(results.every((row) => row.status === 'ok')).toBe(true);
  });

  it('surfaces failing links with remediation detail', () => {
    const results = collectCursorDoctorChecks([
      {
        link: 'node',
        ok: false,
        detail: 'Node.js 22.13+ is required for Cursor SDK Agents (found v20.0.0).',
      },
      {
        link: 'sidecar',
        ok: false,
        detail: 'Cursor SDK sidecar script is missing at /tmp/cursor-sidecar/run-agent.mjs.',
      },
      { link: 'sdk', ok: true, detail: 'workspace sdk present' },
      {
        link: 'native',
        ok: false,
        detail: 'platform unsupported: win32-arm64 (unsupported targets: linux-x64-musl, ...)',
      },
    ]);

    expect(results[0]?.status).toBe('fail');
    expect(results[0]?.detail).toContain('Node.js 22.13');
    expect(results[1]?.detail).toContain('sidecar script is missing');
    expect(results[3]?.detail).toContain('platform unsupported');
  });

  it('appends a probe row when provided', () => {
    const results = collectCursorDoctorChecks([{ link: 'node', ok: true, detail: 'ok' }], {
      ok: true,
      detail: 'validate_api_key reached SDK (auth rejected probe key)',
    });

    expect(results.at(-1)).toMatchObject({
      label: 'Cursor probe',
      status: 'ok',
      detail: 'validate_api_key reached SDK (auth rejected probe key)',
    });
  });
});

describe('cursorRuntimeChainReady', () => {
  it('is true only when every chain link passed', () => {
    expect(
      cursorRuntimeChainReady([
        { link: 'node', ok: true, detail: '' },
        { link: 'sidecar', ok: true, detail: '' },
      ])
    ).toBe(true);
    expect(
      cursorRuntimeChainReady([
        { link: 'node', ok: true, detail: '' },
        { link: 'sidecar', ok: false, detail: 'missing' },
      ])
    ).toBe(false);
  });
});
