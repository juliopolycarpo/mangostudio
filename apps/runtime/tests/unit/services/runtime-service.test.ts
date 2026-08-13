import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeServiceStatusSchema } from '@mangostudio/shared/runtime-home';
import Value from 'typebox/value';
import {
  readRuntimeSlotState,
  writePairingToken,
  writeRuntimeSlotConfig,
  writeServeToken,
} from '../../../src/runtime-home';
import {
  assertServicePreconditions,
  attemptEnableLinger,
  createRuntimeServiceManager,
  execStartUsesCurrent,
  type RuntimeServiceExecDeps,
  type RuntimeServiceExecResult,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveInstallMode,
  systemdUnitPath,
} from '../../../src/services/runtime-service';

const CURRENT = '/home/test/.mango/runtime/remote/current/mangostudio-runtime';

/** Inner XML of the KeepAlive dict only (first match). */
function keepAliveDictBody(plist: string): string {
  const match = plist.match(/<key>KeepAlive<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!match) throw new Error('KeepAlive dict not found');
  return match[1];
}

/** Job plist fragment after the KeepAlive dict closes. */
function plistAfterKeepAlive(plist: string): string {
  const parts = plist.split(/<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/);
  if (parts.length < 2) throw new Error('KeepAlive dict not found');
  return parts[1];
}

function makeDeps(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly hasSystemd?: boolean;
    /** Whether a binary is reachable through the slot `current` link. */
    readonly currentBinaryPresent?: boolean;
    readonly onExec?: (argv: readonly string[]) => RuntimeServiceExecResult;
  } = {}
): RuntimeServiceExecDeps & { readonly files: Map<string, string>; readonly argv: string[][] } {
  const files = new Map<string, string>();
  const argv: string[][] = [];
  const baseEnv: Record<string, string | undefined> = {
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    ...options.env,
  };
  if (options.env?.XDG_RUNTIME_DIR === '') baseEnv.XDG_RUNTIME_DIR = undefined;
  if (options.env?.DBUS_SESSION_BUS_ADDRESS === '') baseEnv.DBUS_SESSION_BUS_ADDRESS = undefined;
  return {
    files,
    argv,
    exec: (command) => {
      argv.push([...command]);
      return Promise.resolve(
        options.onExec?.(command) ?? {
          exitCode: 0,
          stdout: '',
          stderr: '',
        }
      );
    },
    platform: options.platform ?? 'linux',
    env: baseEnv,
    home: '/home/test',
    uid: 1000,
    user: 'test',
    hasSystemd: () => Promise.resolve(options.hasSystemd ?? true),
    writeFile: (path, contents) => {
      files.set(path, contents);
      return Promise.resolve();
    },
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
      return Promise.resolve(value);
    },
    unlink: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    pathExists: () => Promise.resolve(options.currentBinaryPresent ?? true),
  };
}

describe('runtime service templates', () => {
  it('systemd ExecStart uses current binary and connect mode without secrets', () => {
    const unit = renderSystemdUnit(CURRENT, 'connect');
    expect(unit).toContain(`ExecStart=${CURRENT} connect`);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toMatch(/token|secret|wss:\/\//i);
    expect(execStartUsesCurrent(unit, '/home/test/.mango/runtime/remote/current')).toBe(true);
  });

  it('does not call a unit for another home current just because it says "current/"', () => {
    const unit = renderSystemdUnit(
      '/home/other/.mango/runtime/remote/current/mangostudio-runtime',
      'connect'
    );
    expect(execStartUsesCurrent(unit, '/home/test/.mango/runtime/remote/current')).toBe(false);
  });

  it('launchd plist references current binary and serve mode', () => {
    const plist = renderLaunchdPlist(CURRENT, 'serve');
    expect(plist).toContain(`<string>${CURRENT}</string>`);
    expect(plist).toContain('<string>serve</string>');
    expect(plist).not.toMatch(/token|secret/i);
  });

  it('places ThrottleInterval at job top level, not inside KeepAlive', () => {
    const plist = renderLaunchdPlist(CURRENT, 'connect');
    const keepAlive = keepAliveDictBody(plist);
    expect(keepAlive).toContain('<key>SuccessfulExit</key>');
    expect(keepAlive).toContain('<false/>');
    expect(keepAlive).not.toContain('ThrottleInterval');

    const tail = plistAfterKeepAlive(plist);
    expect(tail).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    expect(plist.indexOf('<key>ThrottleInterval</key>')).toBeGreaterThan(
      plist.indexOf('</dict>', plist.indexOf('<key>KeepAlive</key>'))
    );
  });
});

describe('runtime service install', () => {
  it('running install twice rewrites the unit and re-enables', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        { hubUrl: 'wss://hub.test/api/runtime', setup: { state: 'configured' } },
        env
      );
      await writePairingToken('remote', 'pairing-token', env);
      const deps = makeDeps({ env });
      const manager = createRuntimeServiceManager(deps);
      await manager.install('connect');
      await manager.install('connect');
      const unitPath = systemdUnitPath(deps.home);
      expect(deps.files.get(unitPath)).toContain('connect');
      const enableCalls = deps.argv.filter((row) => row.includes('enable'));
      expect(enableCalls.length).toBe(2);
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });

  it('fails when systemctl enable returns a non-zero exit code', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        { hubUrl: 'wss://hub.test/api/runtime', setup: { state: 'configured' } },
        env
      );
      await writePairingToken('remote', 'pairing-token', env);
      const deps = makeDeps({
        env,
        onExec: (argv) => {
          if (argv.includes('enable')) {
            return { exitCode: 1, stdout: '', stderr: 'Failed to enable unit' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      await expect(createRuntimeServiceManager(deps).install('connect')).rejects.toMatchObject({
        kind: 'runtime_service_unsupported',
      });
      expect(deps.argv.some((row) => row.includes('enable'))).toBe(true);
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });

  // A hand-downloaded runtime configures and connects fine but never publishes
  // `current`, so the unit it would get points at nothing.
  it('refuses when no binary is reachable through current, writing no unit', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        { hubUrl: 'wss://hub.test/api/runtime', setup: { state: 'configured' } },
        env
      );
      await writePairingToken('remote', 'pairing-token', env);
      const deps = makeDeps({ env, currentBinaryPresent: false });
      await expect(createRuntimeServiceManager(deps).install('connect')).rejects.toMatchObject({
        kind: 'runtime_service_binary_missing',
      });
      expect(deps.files.size).toBe(0);
      expect(deps.argv.some((row) => row.includes('enable'))).toBe(false);
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });

  it('refuses a macOS install for the same reason before touching launchctl', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        { serveListen: '0.0.0.0:8787', setup: { state: 'configured' } },
        env
      );
      await writeServeToken('remote', 'serve-token', env);
      const deps = makeDeps({ env, platform: 'darwin', currentBinaryPresent: false });
      await expect(createRuntimeServiceManager(deps).install('serve')).rejects.toMatchObject({
        kind: 'runtime_service_binary_missing',
      });
      expect(deps.argv).toEqual([]);
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });
});

describe('resolveInstallMode', () => {
  it('names neither mode when nothing is configured', () => {
    expect(() =>
      resolveInstallMode(undefined, {
        schemaVersion: 1,
        setup: { state: 'configured' },
      } as Parameters<typeof resolveInstallMode>[1])
    ).toThrow(/Neither connect nor serve is configured/);
  });
});

describe('runtime service status mode', () => {
  it('reads connect vs serve from the installed unit when both are configured', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        {
          hubUrl: 'wss://hub.test/api/runtime',
          serveListen: '0.0.0.0:8787',
          setup: { state: 'configured' },
        },
        env
      );
      const deps = makeDeps({
        env,
        onExec: (argv) => {
          if (argv.includes('is-enabled')) return { exitCode: 0, stdout: 'enabled', stderr: '' };
          if (argv.includes('is-active')) return { exitCode: 0, stdout: 'active', stderr: '' };
          if (argv[0] === 'loginctl') return { exitCode: 0, stdout: 'Linger=yes', stderr: '' };
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      deps.files.set(systemdUnitPath(deps.home), renderSystemdUnit(CURRENT, 'serve'));
      const manager = createRuntimeServiceManager(deps);
      const status = await manager.status();
      expect(status.mode).toBe('serve');
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });
});

describe('runtime service status json', () => {
  it('matches the shared schema', async () => {
    const deps = makeDeps({
      onExec: (argv) => {
        if (argv.includes('is-enabled')) return { exitCode: 0, stdout: 'enabled', stderr: '' };
        if (argv.includes('is-active')) return { exitCode: 0, stdout: 'active', stderr: '' };
        if (argv[0] === 'loginctl') return { exitCode: 0, stdout: 'Linger=yes', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    deps.files.set(systemdUnitPath(deps.home), renderSystemdUnit(CURRENT, 'connect'));
    const status = await createRuntimeServiceManager(deps).status();
    expect(Value.Check(RuntimeServiceStatusSchema, status)).toBe(true);
    expect(status.schemaVersion).toBe(1);
    expect(status.installed).toBe(true);
  });
});

describe('runtime service refusals', () => {
  it('refuses pending setup', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig('remote', { setup: { state: 'pending' } }, env);
      await expect(
        assertServicePreconditions('connect', await readRuntimeSlotState('remote', env))
      ).rejects.toMatchObject({ kind: 'runtime_service_setup_pending' });
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });

  it('refuses unconfigured connect', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig('remote', { setup: { state: 'configured' } }, env);
      await expect(
        assertServicePreconditions('connect', await readRuntimeSlotState('remote', env))
      ).rejects.toMatchObject({ kind: 'runtime_service_unconfigured' });
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });

  it('refuses win32 install', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        { hubUrl: 'wss://hub.test/api/runtime', setup: { state: 'configured' } },
        env
      );
      await writePairingToken('remote', 'token', env);
      const deps = makeDeps({ platform: 'win32', env });
      await expect(createRuntimeServiceManager(deps).install('connect')).rejects.toMatchObject({
        kind: 'runtime_service_unsupported',
      });
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });

  it('refuses missing systemd', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        { hubUrl: 'wss://hub.test/api/runtime', setup: { state: 'configured' } },
        env
      );
      await writePairingToken('remote', 'token', env);
      const deps = makeDeps({ hasSystemd: false, env });
      await expect(createRuntimeServiceManager(deps).install('connect')).rejects.toMatchObject({
        kind: 'runtime_service_unsupported',
      });
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });

  it('refuses missing session bus', async () => {
    const mangoHome = await mkdtemp(join(tmpdir(), 'mango-svc-'));
    const env = { MANGO_HOME: mangoHome };
    try {
      await writeRuntimeSlotConfig(
        'remote',
        { hubUrl: 'wss://hub.test/api/runtime', setup: { state: 'configured' } },
        env
      );
      await writePairingToken('remote', 'token', env);
      const deps = makeDeps({
        env: {
          MANGO_HOME: mangoHome,
          XDG_RUNTIME_DIR: '',
          DBUS_SESSION_BUS_ADDRESS: '',
        },
      });
      await expect(createRuntimeServiceManager(deps).install('connect')).rejects.toMatchObject({
        kind: 'runtime_service_no_session_bus',
      });
    } finally {
      await rm(mangoHome, { recursive: true, force: true });
    }
  });
});

describe('runtime service linger', () => {
  it('prints sudo line when loginctl needs root', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const deps = makeDeps({
      onExec: (argv) =>
        argv[0] === 'loginctl'
          ? { exitCode: 1, stdout: '', stderr: 'Access denied' }
          : { exitCode: 0, stdout: '', stderr: '' },
    });
    try {
      await attemptEnableLinger(deps);
      expect(stderr.join('')).toContain('sudo loginctl enable-linger test');
    } finally {
      process.stderr.write = original;
    }
  });
});
