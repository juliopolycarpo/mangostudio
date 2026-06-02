import { describe, expect, it } from 'bun:test';
import {
  checkAuthSecret,
  checkConfig,
  checkDatabase,
  checkDir,
  checkFrontend,
  checkInstance,
  checkRuntime,
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
    server: { host: 'localhost', port: 3001 },
    frontend: { host: 'localhost', port: 5173 },
    database: { path: '/data/db.sqlite' },
    uploads: { dir: '/data/uploads' },
    images: { dir: '/data/images' },
    agents: { dir: '/data/agents' },
    auth: { secret: 'x'.repeat(32), url: 'http://localhost:3001' },
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
    const result = checkInstance(null, false, false);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('not running');
  });

  it('warns on a stale state file', () => {
    expect(checkInstance(makeState(), false, false).status).toBe('warn');
  });

  it('reports a healthy running instance', () => {
    const result = checkInstance(makeState(), true, true);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('health ok');
  });

  it('reports an unreachable running instance', () => {
    expect(checkInstance(makeState(), true, false).detail).toContain('health unreachable');
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
