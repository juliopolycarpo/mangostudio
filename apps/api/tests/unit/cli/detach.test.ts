import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWaiterCommand,
  DETACH_ENV_ALLOWLIST,
  type DetachDeps,
  ensureLogDir,
  POWERSHELL_HOST_FLAGS,
  pickAllowedEnv,
  restartExecutableOptions,
  spawnDetached,
  WINDOWS_SYSTEM_ENV_KEYS,
  waiterArgv,
} from '../../../src/cli/detach';
import type { ServerState } from '../../../src/lib/server-state';
import { installerArgv } from '../../../src/modules/updates/infrastructure/installer-invocation';
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
      'Wait-Process -Id 4242 -ErrorAction SilentlyContinue; ' +
        "& 'npm' 'install' '-g' 'mangostudio@latest' *>> 'C:\\Users\\j\\.mango\\run\\upgrade-1.log'"
    );
  });

  it('never gives up waiting: the caller has already confirmed every pid is stopping, so a timeout could only start the manager against a file still held open', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: [999, 555],
      logFile: 'C:\\log.txt',
    });

    expect(command).not.toContain('-Timeout');
  });

  it('brings the hub back unconditionally when a pre-stopped hub needs recovering, appending that output to the same log', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: [999, 555],
      logFile: 'C:\\log.txt',
      afterSuccess: ['mangostudio', 'serve', '-d', "it's:3001"],
    });

    expect(command).toBe(
      'Wait-Process -Id 999, 555 -ErrorAction SilentlyContinue; ' +
        "& 'npm' 'install' '-g' 'mangostudio@latest' *>> 'C:\\log.txt'; " +
        "& 'mangostudio' 'serve' '-d' 'it''s:3001' *>> 'C:\\log.txt'"
    );
  });

  it('never guards afterSuccess on $LASTEXITCODE: a fresh powershell.exe leaves it $null and Wait-Process never sets it, so gating on it would silently skip recovery', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: 999,
      logFile: 'C:\\log.txt',
      afterSuccess: ['mangostudio', 'restart'],
    });

    expect(command).not.toContain('LASTEXITCODE');
  });

  it('doubles an embedded single quote so PowerShell reads it as one literal quote', () => {
    const command = buildWaiterCommand({
      argv: ['scoop', 'update', "it's-mango"],
      waitForPid: 1,
      logFile: 'C:\\log.txt',
    });

    expect(command).toContain("'it''s-mango'");
  });

  it('clears the hidden keys before the manager and restores them before the comeback', () => {
    // `mangostudio serve -d` runs out of this host's environment, so the hub's
    // runtime config has to survive to the comeback step — but npm and its
    // postinstall hooks must not see it in between.
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: [999, 555],
      logFile: 'C:\\log.txt',
      hiddenFromManager: ['BETTER_AUTH_SECRET', 'DATABASE_PATH'],
      afterSuccess: ['mangostudio', 'serve', '-d', 'localhost:3001'],
    });

    const clear = command.indexOf('Remove-Item');
    const manager = command.indexOf("& 'npm'");
    const restore = command.indexOf('Set-Item');
    const comeback = command.indexOf("& 'mangostudio'");
    expect(clear).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(manager);
    expect(manager).toBeLessThan(restore);
    expect(restore).toBeLessThan(comeback);
    expect(command).toContain("@('BETTER_AUTH_SECRET', 'DATABASE_PATH')");
  });

  it('never writes a hidden value into the command text, only its key', () => {
    // The script text lands in a process listing; the values travel in the
    // host's own environment instead.
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: 999,
      logFile: 'C:\\log.txt',
      hiddenFromManager: ['BETTER_AUTH_SECRET'],
      afterSuccess: ['mangostudio', 'restart'],
    });

    expect(command).toContain('BETTER_AUTH_SECRET');
    expect(command).toContain('[Environment]::GetEnvironmentVariable($k)');
  });

  it('quotes only with single quotes, so Windows command-line escaping never has to carry a double quote', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: 999,
      logFile: 'C:\\log.txt',
      hiddenFromManager: ['BETTER_AUTH_SECRET'],
      afterSuccess: ['mangostudio', 'restart'],
    });

    expect(command).not.toContain('"');
  });

  it('adds no hide/restore steps when nothing is hidden', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: 999,
      logFile: 'C:\\log.txt',
      hiddenFromManager: [],
    });

    expect(command).not.toContain('Remove-Item');
    expect(command).not.toContain('Set-Item');
  });

  it('waits on every pid in a list, comma-separated, when the CLI is not the process holding the exe open', () => {
    const command = buildWaiterCommand({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: [999, 555],
      logFile: 'C:\\log.txt',
    });

    expect(command).toStartWith('Wait-Process -Id 999, 555 -ErrorAction');
  });
});

describe('waiterArgv', () => {
  it('bypasses the execution policy, so a Restricted host can still run npm.ps1', () => {
    // Unlike `installerArgv`, the waiter used to get only -NoProfile
    // -NonInteractive: `npm` resolves to `npm.ps1` ahead of `npm.cmd`, and a
    // default-Restricted machine refuses to run it.
    const argv = waiterArgv({
      argv: ['npm', 'install', '-g', 'mangostudio@latest'],
      waitForPid: 1,
      logFile: 'C:\\log.txt',
    });

    expect(argv[0]).toBe('powershell.exe');
    expect(argv.slice(0, -1)).toContain('-ExecutionPolicy');
    expect(argv.slice(0, -1)).toContain('Bypass');
    expect(argv.at(-2)).toBe('-Command');
  });
});

describe('POWERSHELL_HOST_FLAGS', () => {
  it('names the flags every PowerShell host this project starts is given', () => {
    // `npm`/`pnpm` resolve to their `.ps1` shim ahead of the `.cmd` one. On a
    // default-Restricted machine — anyone who installed through CMD without
    // ever enabling scripts — the host refuses to run it, and the delegated
    // upgrade dies before the manager starts.
    expect(POWERSHELL_HOST_FLAGS).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
    ]);
  });

  it('is the same prelude installerArgv gives the embedded script', () => {
    const argv = installerArgv('ps1', 'C:\\t\\install.ps1', ['-Prune'], () => null);

    expect(argv.slice(1, 1 + POWERSHELL_HOST_FLAGS.length)).toEqual([...POWERSHELL_HOST_FLAGS]);
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
