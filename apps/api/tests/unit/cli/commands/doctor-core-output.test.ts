/**
 * Pins the English text `mangostudio doctor` prints for the core checks.
 *
 * The checks carry a stable key and params now, and the CLI renders its line
 * from them. This is the guard that the move changed no character of the
 * terminal output: every expected line below is the text the command printed
 * when the rows were still built from English prose.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MachineCheck } from '@mangostudio/shared/machine';
import { deniedCapabilities, RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';

import { DEFAULT_DOCTOR_ARGS } from '../../../../src/cli/args';
import { runDoctor } from '../../../../src/cli/commands/doctor';
import type { FsProbe } from '../../../../src/cli/doctor-checks';
import { probeRuntimeSlots } from '../../../../src/cli/runtime-slot-probe';
import type { BuildInfo } from '../../../../src/lib/build-info';
import { getHomeMangoDir, getVersion, type MangoConfig } from '../../../../src/lib/config';
import { getLogsDir, getRunDir } from '../../../../src/lib/mango-paths';
import { isStandaloneExecutable } from '../../../../src/lib/runtime-paths';
import type { ServerState } from '../../../../src/lib/server-state';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const ALL_OK: FsProbe = { exists: () => true, isWritable: () => true };
const NOTHING: FsProbe = { exists: () => false, isWritable: () => false };

const SERVER_BUILD: BuildInfo = {
  gitSha: 'abc123',
  gitDirty: false,
  builtAt: '2026-07-04T12:00:00.000Z',
  buildType: 'production',
};
const SERVER_BUILD_TEXT = 'abc123 (built 2026-07-04T12:00:00.000Z, clean, production)';

function makeConfig(overrides: Partial<MangoConfig> = {}): MangoConfig {
  return {
    server: { host: 'localhost', port: 3001, publicUrl: '', allowedOrigins: [] },
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
    checkpoints: { dir: '/data/checkpoints', maxFileBytes: 1024 },
    auth: { secret: 'x'.repeat(32), url: 'http://localhost:3001' },
    security: { trustProxy: false, allowDirectLoopback: true },
    updates: { check: true, channel: null },
    environments: {
      ltsRefresh: false,
      installsEnabled: false,
      container: false,
      wslExecutable: '',
    },
    terminal: { enabled: true, idleTimeoutMinutes: 30, maxSessionsPerUser: 8, scrollbackKib: 256 },
    chatgpt: { authBaseUrl: 'https://auth.openai.com', apiBaseUrl: 'https://api.openai.com' },
    secretStore: { unsafeFileFallbackDir: '' },
    corsOrigins: [],
    configFilePath: '/data/config.toml',
    ...overrides,
  };
}

/** Two slots on a temporary runtime home: a narrowed host and a remote one awaiting consent. */
async function slotHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mango-doctor-output-'));
  homes.push(home);
  const hostDir = join(home, 'runtime', 'host');
  await mkdir(hostDir, { recursive: true });
  await writeFile(
    join(hostDir, 'runtime.json'),
    JSON.stringify({
      schemaVersion: 1,
      slot: 'host',
      allow: RUNTIME_CONSENT_PRESETS.readonly,
      setup: { state: 'configured' },
    })
  );
  await mkdir(join(home, 'runtime', 'remote'), { recursive: true });
  return home;
}

/**
 * The core rows `runDoctor` prints, header and tally included. The runtime
 * cache row reads the real `~/.mango/runtime-cache` and the Installed via and
 * Update rows are outside the keyed slice, so they are left out.
 */
async function printCoreRows(
  overrides: Record<string, unknown>,
  args: Partial<typeof DEFAULT_DOCTOR_ARGS> = {}
): Promise<{ lines: string[]; raw: string[]; exitCodes: number[] }> {
  const lines: string[] = [];
  const exitCodes: number[] = [];
  const home = await slotHome();
  await runDoctor({ ...DEFAULT_DOCTOR_ARGS, ...args }, {
    loadConfig: () => makeConfig(),
    env: {},
    fs: ALL_OK,
    frontendDir: () => '/app',
    controller: new FakeProcessController(),
    readState: () => Promise.resolve(null),
    isCursorConfigured: () => false,
    probeRuntimeBinary: () =>
      Promise.resolve({
        path: '/repo/target/debug/mangostudio-runtime',
        present: true,
        version: '0.1.1',
        error: null,
      }),
    probeRuntimeSlots: () => probeRuntimeSlots(home),
    probeSshClient: () =>
      Promise.resolve({ path: '/usr/bin/ssh', version: 'OpenSSH_9.6p1', error: null }),
    listChatGptConnectors: () => [],
    getBuildInfo: () => SERVER_BUILD,
    getCheckoutBuildInfo: () => SERVER_BUILD,
    readFrontendBuildInfo: () => SERVER_BUILD,
    getEmbeddedFrontend: () => null,
    collectSkillsChecks: () => [],
    listMcpServers: () => [],
    collectMcpChecks: () => Promise.resolve([]),
    collectEnvironmentChecks: () => Promise.resolve([]),
    collectLibraryChecks: () => Promise.resolve([]),
    isTty: () => false,
    now: () => 0,
    log: (message: string) => lines.push(message),
    exit: (code: number) => exitCodes.push(code),
    releaseRuntimes: () => Promise.resolve(),
    ...overrides,
  } as never);
  const kept = lines
    .flatMap((line) => line.split('\n'))
    .filter(
      (line) =>
        !line.includes('Runtime cache') &&
        !line.includes('Installed via') &&
        !/^\[\w+\]\s+Update\b/.test(line)
    );
  return { lines: kept, raw: lines, exitCodes };
}

function row(badge: '[ok]  ' | '[warn]' | '[fail]', label: string, detail: string): string {
  return `${badge} ${label.padEnd(18)} ${detail}`;
}

describe('mangostudio doctor core rows', () => {
  it('prints the healthy install exactly as before the rows were keyed', async () => {
    const { lines, exitCodes } = await printCoreRows({});
    const home = homes[0] as string;
    const [hostProbe] = await probeRuntimeSlots(home);
    const hostConfigDenied = deniedCapabilities(
      (hostProbe as NonNullable<typeof hostProbe>).config.allow
    );
    expect(hostConfigDenied.length).toBeGreaterThan(0);

    expect(lines).toEqual([
      'MangoStudio doctor',
      '',
      row('[ok]  ', 'Home directory', `${getHomeMangoDir()} (writable)`),
      row('[ok]  ', 'Logs directory', `${getLogsDir()} (writable)`),
      row('[ok]  ', 'Run directory', `${getRunDir()} (writable)`),
      row('[ok]  ', 'Config', 'localhost:3001 (/data/config.toml)'),
      row('[ok]  ', 'Database', '/data/db.sqlite'),
      row('[ok]  ', 'Frontend', '/app (present)'),
      row('[ok]  ', 'Auth secret', 'set (32+ characters)'),
      row('[ok]  ', 'Instance', 'not running'),
      row(
        '[ok]  ',
        'Runtime',
        `v${getVersion()} ${process.platform}-${process.arch} ${isStandaloneExecutable() ? 'standalone' : 'dev'}`
      ),
      row('[ok]  ', 'Runtime binary', 'v0.1.1 at /repo/target/debug/mangostudio-runtime'),
      row(
        '[ok]  ',
        'Runtime slot (host)',
        `readonly (denied: ${hostConfigDenied.join(', ')})  ${join(home, 'runtime', 'host')}`
      ),
      row(
        '[warn]',
        'Runtime slot (remote)',
        `waiting for consent; run "mangostudio-runtime setup --slot remote" on that machine`
      ),
      row('[ok]  ', 'SSH client', 'OpenSSH_9.6p1  /usr/bin/ssh'),
      row('[ok]  ', 'Server build', SERVER_BUILD_TEXT),
      row('[ok]  ', 'Checkout build', SERVER_BUILD_TEXT),
      row('[ok]  ', 'Frontend build', SERVER_BUILD_TEXT),
      '',
      '1 warning(s), 0 failure(s).',
    ]);
    expect(exitCodes).toEqual([]);
  });
});

// A second install that trips every other branch of the core rows.
describe('mangostudio doctor core rows on a degraded install', () => {
  it('prints each failure and warning exactly as before the rows were keyed', async () => {
    const staleState: ServerState = {
      pid: 42,
      port: 3001,
      host: 'localhost',
      startedAt: 0,
      logFile: '',
      version: 't',
    };
    const checkoutBuild: BuildInfo = { ...SERVER_BUILD, gitSha: 'def456' };
    const { lines, exitCodes } = await printCoreRows({
      loadConfig: () =>
        makeConfig({
          auth: { secret: 'short', url: '' },
          configFilePath: '',
          database: { path: ':memory:' },
        }),
      fs: NOTHING,
      readState: () => Promise.resolve(staleState),
      probeRuntimeBinary: () =>
        Promise.resolve({ path: null, present: false, version: null, error: null }),
      probeRuntimeSlots: () => Promise.resolve([]),
      probeSshClient: () => Promise.resolve({ path: null, version: null, error: null }),
      getCheckoutBuildInfo: () => checkoutBuild,
      readFrontendBuildInfo: () => null,
    });

    expect(lines).toEqual([
      'MangoStudio doctor',
      '',
      row('[fail]', 'Home directory', `${getHomeMangoDir()} (parent not writable)`),
      row('[fail]', 'Logs directory', `${getLogsDir()} (parent not writable)`),
      row('[fail]', 'Run directory', `${getRunDir()} (parent not writable)`),
      row('[ok]  ', 'Config', 'localhost:3001 (defaults)'),
      row('[ok]  ', 'Database', 'in-memory'),
      row('[warn]', 'Frontend', '/app (missing — API only)'),
      row('[fail]', 'Auth secret', 'BETTER_AUTH_SECRET must be at least 32 characters.'),
      row('[warn]', 'Instance', 'stale state file (PID 42)'),
      row(
        '[ok]  ',
        'Runtime',
        `v${getVersion()} ${process.platform}-${process.arch} ${isStandaloneExecutable() ? 'standalone' : 'dev'}`
      ),
      row(
        '[fail]',
        'Runtime binary',
        'not built in this source checkout; Local cannot start. Run "cargo build -p mangostudio-runtime --locked" from the repository root'
      ),
      row('[warn]', 'SSH client', 'no ssh on PATH; SSH environments cannot start'),
      row('[ok]  ', 'Server build', SERVER_BUILD_TEXT),
      row(
        '[warn]',
        'Checkout build',
        'checkout def456 differs from server abc123; restart or rebuild if unexpected'
      ),
      row(
        '[warn]',
        'Frontend build',
        `${join('/app', 'build-info.json')} missing; rebuild frontend assets to compare`
      ),
      '',
      '5 warning(s), 5 failure(s).',
    ]);
    expect(exitCodes).toEqual([1]);
  });
});

describe('mangostudio doctor --json', () => {
  it('keeps the English fields and adds the keys and params the machine page renders from', async () => {
    const { raw } = await printCoreRows({}, { json: true });
    const report = JSON.parse(raw.join('\n')) as {
      checks: MachineCheck[];
    };

    expect(report.checks.find((check) => check.labelKey === 'core.label.config')).toEqual({
      label: 'Config',
      labelKey: 'core.label.config',
      status: 'ok',
      detail: 'localhost:3001 (/data/config.toml)',
      detailKey: 'core.detail.configFile',
      params: { host: 'localhost', port: '3001', path: '/data/config.toml' },
    });
  });
});
