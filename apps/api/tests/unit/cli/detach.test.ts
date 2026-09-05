import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWaiterCommand,
  DETACH_ENV_ALLOWLIST,
  type DetachDeps,
  ensureLogDir,
  pickAllowedEnv,
  restartExecutableOptions,
  spawnDetached,
  WINDOWS_SYSTEM_ENV_KEYS,
} from '../../../src/cli/detach';
import type { ServerState } from '../../../src/lib/server-state';
import { FakeProcessController } from '../../support/mocks/fake-process-controller';

const CHILD_PID = 100;

function makeState(): ServerState {
  return {
    pid: CHILD_PID,
    port: 3001,
    host: 'localhost',
    startedAt: 0,
    logFile: 'server.log',
    version: 'test',
  };
}

function baseDeps(overrides: Partial<DetachDeps> = {}): Partial<DetachDeps> {
  let now = 0;
  return {
    controller: new FakeProcessController([CHILD_PID]),
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    spawn: () => CHILD_PID,
    readState: () => Promise.resolve(makeState()),
    confirmsHealthy: () => Promise.resolve(true),
    ...overrides,
  };
}

describe('spawnDetached', () => {
  it('resolves with the child pid once it is healthy', async () => {
    let spawnedPort = 0;
    let spawnedHost = '';
    const result = await spawnDetached(3001, 'localhost', {
      ...baseDeps(),
      spawn: (port, host) => {
        spawnedPort = port;
        spawnedHost = host;
        return CHILD_PID;
      },
    });

    expect(result.pid).toBe(CHILD_PID);
    expect(result.port).toBe(3001);
    expect(result.logFile).toMatch(/server-\d{8}-\d{6}\.log$/);
    expect(spawnedPort).toBe(3001);
    expect(spawnedHost).toBe('localhost');
  });

  it('fails fast when the child dies during startup', async () => {
    const deps = baseDeps({ controller: new FakeProcessController([]) });

    await expect(spawnDetached(3001, 'localhost', deps)).rejects.toThrow(/failed to start/i);
  });

  it('fails when the child never becomes healthy', async () => {
    const deps = baseDeps({ confirmsHealthy: () => Promise.resolve(false) });

    await expect(spawnDetached(3001, 'localhost', deps)).rejects.toThrow(/did not become healthy/i);
  });
});

describe('restartExecutableOptions', () => {
  it('names the current pointer argv when the executable resolves to it', () => {
    expect(
      restartExecutableOptions({ pointer: 'current', argv: ['/mango/dist/current/mangostudio'] })
    ).toEqual({ executable: ['/mango/dist/current/mangostudio'] });
  });

  it('re-execs today (no override) for every other pointer kind', () => {
    for (const pointer of ['versioned', 'external', 'source'] as const) {
      expect(restartExecutableOptions({ pointer, argv: ['/anything'] })).toEqual({});
    }
  });
});

describe('buildWaiterCommand', () => {
  it('waits on this process before invoking the manager and appending its output', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: 4242,
      logFile: 'C:\\Users\\j\\.mango\\run\\upgrade-1.log',
    });

    expect(command).toBe(
      'Wait-Process -Id 4242 -Timeout 60 -ErrorAction SilentlyContinue; ' +
        "& 'npm' 'install' '-g' 'mangostudio@latest' *>> 'C:\\Users\\j\\.mango\\run\\upgrade-1.log'"
    );
  });

  it('doubles an embedded single quote so PowerShell reads it as one literal quote', () => {
    const command = buildWaiterCommand({
      argv: ['scoop', 'update', "it's-mango"],
      waitForPid: 1,
      logFile: 'C:\\log.txt',
    });

    expect(command).toContain("'it''s-mango'");
  });

  it('waits on every pid in a list, comma-separated, when the CLI is not the process holding the exe open', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: [999, 555],
      logFile: 'C:\\log.txt',
    });

    expect(command).toStartWith('Wait-Process -Id 999, 555 -Timeout 60');
  });
});

describe('WINDOWS_SYSTEM_ENV_KEYS', () => {
  it('includes host-architecture detection alongside the executable-resolution and data-directory keys', () => {
    // install.ps1's Get-Platform reads PROCESSOR_ARCHITECTURE/
    // PROCESSOR_ARCHITEW6432 to classify the host; DETACH_ENV_ALLOWLIST
    // composes this same list, so both the detached hub and the embedded
    // install script (upgrade-service.ts's SCRIPT_ENV_PASSTHROUGH) get it
    // from one place instead of two copies drifting apart.
    expect(WINDOWS_SYSTEM_ENV_KEYS).toContain('PROCESSOR_ARCHITECTURE');
    expect(WINDOWS_SYSTEM_ENV_KEYS).toContain('PROCESSOR_ARCHITEW6432');
    expect(WINDOWS_SYSTEM_ENV_KEYS).toContain('PATHEXT');
    for (const key of WINDOWS_SYSTEM_ENV_KEYS) {
      expect(DETACH_ENV_ALLOWLIST.has(key)).toBe(true);
    }
  });
});

describe('pickAllowedEnv', () => {
  it('keeps only allowlisted keys, dropping anything unset', () => {
    const env = pickAllowedEnv({ PATH: '/usr/bin', SECRET: 'x', EMPTY: undefined }, [
      'PATH',
      'EMPTY',
      'MISSING',
    ]);

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('also keeps any key starting with a given prefix', () => {
    const env = pickAllowedEnv(
      { PATH: '/usr/bin', npm_config_registry: 'https://registry.example.test', SECRET: 'x' },
      ['PATH'],
      ['npm_config_']
    );

    expect(env).toEqual({ PATH: '/usr/bin', npm_config_registry: 'https://registry.example.test' });
  });
});

describe('ensureLogDir', () => {
  // spawnDetachedWaiter itself is Windows-only and cannot be exercised end to
  // end here (this host's `powershell.exe`, reachable through WSL interop,
  // would spawn a real Windows process) — this covers the directory-creation
  // guard it calls before spawning, in isolation.
  it('creates a missing log directory, so PowerShell’s redirect never targets one that does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'mango-waiter-'));
    const nested = join(root, 'run', 'nested');
    const logFile = join(nested, 'upgrade-1.log');
    try {
      expect(existsSync(nested)).toBe(false);
      ensureLogDir(logFile);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when the directory already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'mango-waiter-'));
    try {
      expect(() => ensureLogDir(join(root, 'upgrade-1.log'))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
