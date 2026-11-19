/**
 * Every branch of the core doctor checks, pinned to the English line the CLI
 * has always printed for it. A core row now carries a key and params and its
 * English comes from the shared template, so a template edited by accident
 * shows here as the exact label/detail that moved.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  MACHINE_CHECK_TEMPLATES_EN,
  MACHINE_DOCTOR_TEMPLATES_EN,
} from '@mangostudio/shared/machine/check-text-en';
import { RUNTIME_CAPABILITY_KEYS } from '@mangostudio/shared/runtime-home';

import {
  checkAuthSecret,
  checkConfig,
  checkDatabase,
  checkDir,
  checkEmbeddedFrontend,
  checkEmbeddedFrontendInServer,
  checkFrontend,
  checkInstance,
  type CheckResult,
  checkRuntime,
  checkRuntimeBinary,
  checkRuntimeCache,
  checkRuntimeSlot,
  checkSshClient,
  collectBuildIdentityChecks,
  type FsProbe,
} from '../../../src/cli/doctor-checks';
import type { RuntimeSlotProbe } from '../../../src/cli/runtime-slot-probe';
import type { BuildInfo } from '../../../src/lib/build-info';
import type { MangoConfig } from '../../../src/lib/config';
import type { ServerState } from '../../../src/lib/server-state';

const EXISTS_NOT_WRITABLE: FsProbe = { exists: () => true, isWritable: () => false };
const NOTHING: FsProbe = { exists: () => false, isWritable: () => false };

function configWith(overrides: {
  host?: string;
  port?: number;
  configFilePath?: string;
  databasePath?: string;
  secret?: string;
}): MangoConfig {
  return {
    server: { host: overrides.host ?? 'localhost', port: overrides.port ?? 3001 },
    configFilePath: overrides.configFilePath ?? '',
    database: { path: overrides.databasePath ?? '/data/db.sqlite' },
    auth: { secret: overrides.secret ?? 'x'.repeat(32) },
  } as MangoConfig;
}

function build(gitSha: string, gitDirty: boolean | 'unknown' = true): BuildInfo {
  return { gitSha, gitDirty, builtAt: 'dev', buildType: 'dev' };
}

/** Every capability allowed, bar the ones named: what a slot's resolved consent looks like. */
function allowEverythingExcept(...denied: string[]): Record<string, boolean> {
  return Object.fromEntries(RUNTIME_CAPABILITY_KEYS.map((key) => [key, !denied.includes(key)]));
}

/** A slot probe; `config` overrides are partial, since a probe row only reads a few fields of it. */
function slotProbe(
  overrides: Partial<Omit<RuntimeSlotProbe, 'config'>> & { config?: Record<string, unknown> }
): RuntimeSlotProbe {
  return {
    slot: 'host',
    directory: '/home/u/.mango/runtime/host',
    error: null,
    ...overrides,
    config: {
      setup: { state: 'configured' },
      version: null,
      profile: 'full',
      allow: allowEverythingExcept(),
      ...(overrides.config as object),
    },
  } as unknown as RuntimeSlotProbe;
}

const STATE: ServerState = {
  pid: 7,
  port: 4000,
  host: 'localhost',
  startedAt: 0,
  logFile: '',
  version: 't',
};

interface EnglishCase {
  readonly name: string;
  readonly row: CheckResult;
  readonly expected: { label: string; status: 'ok' | 'warn' | 'fail'; detail: string };
}

const WRITABLE: FsProbe = { exists: () => true, isWritable: () => true };
/** Only `/home` exists, and it is writable: `/home/u/.mango` is creatable. */
const PARENT_ONLY: FsProbe = { exists: (path) => path === '/home', isWritable: () => true };

const CASES: readonly EnglishCase[] = [
  {
    name: 'writable directory',
    row: checkDir('core.label.homeDirectory', '/home/u/.mango', WRITABLE),
    expected: {
      label: 'Home directory',
      status: 'ok',
      detail: '/home/u/.mango (writable)',
    },
  },
  {
    name: 'directory that exists but is not writable',
    row: checkDir('core.label.logsDirectory', '/home/u/.mango/logs', EXISTS_NOT_WRITABLE),
    expected: {
      label: 'Logs directory',
      status: 'fail',
      detail: '/home/u/.mango/logs (not writable)',
    },
  },
  {
    name: 'directory that will be created',
    row: checkDir('core.label.runDirectory', '/home/u/.mango/run', PARENT_ONLY),
    expected: {
      label: 'Run directory',
      status: 'ok',
      detail: '/home/u/.mango/run (will be created)',
    },
  },
  {
    name: 'directory whose parent is not writable',
    row: checkDir('core.label.homeDirectory', '/home/u/.mango', NOTHING),
    expected: {
      label: 'Home directory',
      status: 'fail',
      detail: '/home/u/.mango (parent not writable)',
    },
  },
  {
    name: 'frontend embedded in the running server',
    row: checkEmbeddedFrontendInServer(),
    expected: {
      label: 'Frontend',
      status: 'ok',
      detail: 'embedded in running server binary',
    },
  },
  {
    name: 'config with a file',
    row: checkConfig(configWith({ configFilePath: '/data/config.toml' })),
    expected: { label: 'Config', status: 'ok', detail: 'localhost:3001 (/data/config.toml)' },
  },
  {
    name: 'config on defaults',
    row: checkConfig(configWith({})),
    expected: { label: 'Config', status: 'ok', detail: 'localhost:3001 (defaults)' },
  },
  {
    name: 'in-memory database',
    row: checkDatabase(configWith({ databasePath: ':memory:' }), NOTHING),
    expected: { label: 'Database', status: 'ok', detail: 'in-memory' },
  },
  {
    name: 'database whose directory is not writable',
    row: checkDatabase(configWith({ databasePath: '/data/db.sqlite' }), EXISTS_NOT_WRITABLE),
    expected: { label: 'Database', status: 'fail', detail: '/data (not writable)' },
  },
  {
    name: 'database path',
    row: checkDatabase(configWith({ databasePath: '/data/db.sqlite' }), {
      exists: () => true,
      isWritable: () => true,
    }),
    expected: { label: 'Database', status: 'ok', detail: '/data/db.sqlite' },
  },
  {
    name: 'frontend present',
    row: checkFrontend('/app', { exists: () => true, isWritable: () => true }),
    expected: { label: 'Frontend', status: 'ok', detail: '/app (present)' },
  },
  {
    name: 'frontend missing',
    row: checkFrontend('/app', NOTHING),
    expected: { label: 'Frontend', status: 'warn', detail: '/app (missing — API only)' },
  },
  {
    name: 'frontend embedded in the binary',
    row: checkEmbeddedFrontend(12),
    expected: { label: 'Frontend', status: 'ok', detail: 'embedded in binary (12 files)' },
  },
  {
    name: 'auth secret unset',
    row: checkAuthSecret(configWith({ secret: '' })),
    expected: {
      label: 'Auth secret',
      status: 'fail',
      detail: 'BETTER_AUTH_SECRET is required and must be at least 32 characters.',
    },
  },
  {
    name: 'auth secret too short',
    row: checkAuthSecret(configWith({ secret: 'short' })),
    expected: {
      label: 'Auth secret',
      status: 'fail',
      detail: 'BETTER_AUTH_SECRET must be at least 32 characters.',
    },
  },
  {
    name: 'auth secret set',
    row: checkAuthSecret(configWith({})),
    expected: { label: 'Auth secret', status: 'ok', detail: 'set (32+ characters)' },
  },
  {
    name: 'instance not running',
    row: checkInstance(null, false),
    expected: { label: 'Instance', status: 'ok', detail: 'not running' },
  },
  {
    name: 'instance with a stale state file',
    row: checkInstance(STATE, false),
    expected: { label: 'Instance', status: 'warn', detail: 'stale state file (PID 7)' },
  },
  {
    name: 'instance running',
    row: checkInstance(STATE, true),
    expected: {
      label: 'Instance',
      status: 'ok',
      detail: 'running (PID 7, port 4000, health not probed)',
    },
  },
  {
    name: 'standalone runtime',
    row: checkRuntime('1.2.3', true),
    expected: {
      label: 'Runtime',
      status: 'ok',
      detail: `v1.2.3 ${process.platform}-${process.arch} standalone`,
    },
  },
  {
    name: 'development runtime',
    row: checkRuntime('1.2.3', false),
    expected: {
      label: 'Runtime',
      status: 'ok',
      detail: `v1.2.3 ${process.platform}-${process.arch} dev`,
    },
  },
  {
    name: 'runtime binary never built',
    row: checkRuntimeBinary({ path: null, present: false, version: null, error: null }, 'dev'),
    expected: {
      label: 'Runtime binary',
      status: 'fail',
      detail:
        'not built in this source checkout; Local cannot start. Run "cargo build -p mangostudio-runtime --locked" from the repository root',
    },
  },
  {
    name: 'runtime binary missing',
    row: checkRuntimeBinary(
      { path: '/opt/rt', present: false, version: null, error: null },
      '1.0.0'
    ),
    expected: {
      label: 'Runtime binary',
      status: 'fail',
      detail:
        'missing at /opt/rt; Local cannot start. Reinstall MangoStudio so it ships beside the hub, or set MANGOSTUDIO_RUNTIME_BINARY',
    },
  },
  {
    name: 'runtime binary that fails its version probe',
    row: checkRuntimeBinary(
      { path: '/opt/rt', present: true, version: null, error: 'exited with code 126' },
      '1.0.0'
    ),
    expected: {
      label: 'Runtime binary',
      status: 'warn',
      detail: '/opt/rt did not report a version (exited with code 126)',
    },
  },
  {
    name: 'runtime binary that reports nothing and no reason',
    row: checkRuntimeBinary(
      { path: '/opt/rt', present: true, version: null, error: null },
      '1.0.0'
    ),
    expected: {
      label: 'Runtime binary',
      status: 'warn',
      detail: '/opt/rt did not report a version (unknown reason)',
    },
  },
  {
    name: 'runtime binary from another release',
    row: checkRuntimeBinary(
      { path: '/opt/rt', present: true, version: '0.9.0', error: null },
      '1.0.0'
    ),
    expected: {
      label: 'Runtime binary',
      status: 'warn',
      detail: 'v0.9.0 does not match hub v1.0.0; reinstall so both come from one release',
    },
  },
  {
    name: 'runtime binary in step with the hub',
    row: checkRuntimeBinary(
      { path: '/opt/rt', present: true, version: '1.0.0', error: null },
      '1.0.0'
    ),
    expected: { label: 'Runtime binary', status: 'ok', detail: 'v1.0.0 at /opt/rt' },
  },
  {
    name: 'slot whose runtime.json is unreadable',
    row: checkRuntimeSlot(slotProbe({ slot: 'remote', error: 'is not valid JSON' })),
    expected: {
      label: 'Runtime slot (remote)',
      status: 'fail',
      detail:
        'runtime.json in /home/u/.mango/runtime/host is not valid JSON; run "mangostudio-runtime setup --slot remote" to rewrite it',
    },
  },
  {
    name: 'slot waiting for consent',
    row: checkRuntimeSlot(slotProbe({ config: { setup: { state: 'pending' } } })),
    expected: {
      label: 'Runtime slot (host)',
      status: 'warn',
      detail: 'waiting for consent; run "mangostudio-runtime setup --slot host" on that machine',
    },
  },
  {
    name: 'slot with no version and nothing denied',
    row: checkRuntimeSlot(slotProbe({})),
    expected: {
      label: 'Runtime slot (host)',
      status: 'ok',
      detail: 'full  /home/u/.mango/runtime/host',
    },
  },
  {
    name: 'slot with a version and nothing denied',
    row: checkRuntimeSlot(slotProbe({ config: { version: '1.0.0' } })),
    expected: {
      label: 'Runtime slot (host)',
      status: 'ok',
      detail: 'v1.0.0  full  /home/u/.mango/runtime/host',
    },
  },
  {
    name: 'slot with no version and a denied capability',
    row: checkRuntimeSlot(slotProbe({ config: { allow: allowEverythingExcept('shell', 'git') } })),
    expected: {
      label: 'Runtime slot (host)',
      status: 'ok',
      detail: 'full (denied: shell, git)  /home/u/.mango/runtime/host',
    },
  },
  {
    name: 'slot with a version and a denied capability',
    row: checkRuntimeSlot(
      slotProbe({
        config: { version: '1.0.0', profile: 'custom', allow: allowEverythingExcept('shell') },
      })
    ),
    expected: {
      label: 'Runtime slot (host)',
      status: 'ok',
      detail: 'v1.0.0  custom (denied: shell)  /home/u/.mango/runtime/host',
    },
  },
  {
    name: 'empty runtime cache',
    row: checkRuntimeCache({ directory: '/home/u/.mango/runtime-cache', versions: [] }),
    expected: {
      label: 'Runtime cache',
      status: 'ok',
      detail: 'empty  /home/u/.mango/runtime-cache',
    },
  },
  {
    name: 'runtime cache holding two releases',
    row: checkRuntimeCache({
      directory: '/home/u/.mango/runtime-cache',
      versions: ['1.0.0', '1.1.0'],
    }),
    expected: {
      label: 'Runtime cache',
      status: 'ok',
      detail: '1.0.0, 1.1.0  /home/u/.mango/runtime-cache',
    },
  },
  {
    name: 'no ssh client',
    row: checkSshClient({ path: null, version: null, error: null }),
    expected: {
      label: 'SSH client',
      status: 'warn',
      detail: 'no ssh on PATH; SSH environments cannot start',
    },
  },
  {
    name: 'ssh client that fails its version probe',
    row: checkSshClient({ path: '/usr/bin/ssh', version: null, error: 'exited with code 1' }),
    expected: {
      label: 'SSH client',
      status: 'warn',
      detail: '/usr/bin/ssh did not report a version (exited with code 1)',
    },
  },
  {
    name: 'ssh client that reports nothing and no reason',
    row: checkSshClient({ path: '/usr/bin/ssh', version: null, error: null }),
    expected: {
      label: 'SSH client',
      status: 'warn',
      detail: '/usr/bin/ssh did not report a version (unknown reason)',
    },
  },
  {
    name: 'ssh client',
    row: checkSshClient({ path: '/usr/bin/ssh', version: 'OpenSSH_9.6p1', error: null }),
    expected: { label: 'SSH client', status: 'ok', detail: 'OpenSSH_9.6p1  /usr/bin/ssh' },
  },
];

const AGREEING_BUILD_TEXT = 'abc (built dev, dirty, dev)';

const BUILD_CASES: readonly (readonly [
  string,
  Parameters<typeof collectBuildIdentityChecks>[0],
  { label: string; status: 'ok' | 'warn' | 'fail'; detail: string }[],
])[] = [
  [
    'builds that agree',
    {
      serverBuild: build('abc'),
      checkoutBuild: build('abc'),
      frontendBuild: build('abc'),
      frontendDir: '/app',
    },
    [
      { label: 'Server build', status: 'ok', detail: AGREEING_BUILD_TEXT },
      { label: 'Checkout build', status: 'ok', detail: AGREEING_BUILD_TEXT },
      { label: 'Frontend build', status: 'ok', detail: AGREEING_BUILD_TEXT },
    ],
  ],
  [
    'a clean tree and an unknown dirty state',
    {
      serverBuild: build('abc', false),
      checkoutBuild: build('abc', 'unknown'),
      frontendBuild: build('abc', false),
      frontendDir: '/app',
    },
    [
      { label: 'Server build', status: 'ok', detail: 'abc (built dev, clean, dev)' },
      { label: 'Checkout build', status: 'ok', detail: 'abc (built dev, dirty unknown, dev)' },
      { label: 'Frontend build', status: 'ok', detail: 'abc (built dev, clean, dev)' },
    ],
  ],
  [
    'no server build and a stale frontend stamp',
    {
      serverBuild: null,
      checkoutBuild: build('abc'),
      frontendBuild: null,
      frontendDir: '/app',
    },
    [
      {
        label: 'Server build',
        status: 'warn',
        detail: 'running server did not report build metadata',
      },
      { label: 'Checkout build', status: 'ok', detail: AGREEING_BUILD_TEXT },
      {
        label: 'Frontend build',
        status: 'warn',
        detail: `${join('/app', 'build-info.json')} missing; rebuild frontend assets to compare`,
      },
    ],
  ],
  [
    'checkout and frontend that differ from the server',
    {
      serverBuild: build('abc'),
      checkoutBuild: build('def'),
      frontendBuild: build('ghi'),
      frontendDir: '/app',
    },
    [
      { label: 'Server build', status: 'ok', detail: AGREEING_BUILD_TEXT },
      {
        label: 'Checkout build',
        status: 'warn',
        detail: 'checkout def differs from server abc; restart or rebuild if unexpected',
      },
      { label: 'Frontend build', status: 'warn', detail: 'frontend ghi differs from server abc' },
    ],
  ],
];

describe('core doctor checks, English text', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, { row, expected }) => {
      expect({ label: row.label, status: row.status, detail: row.detail }).toEqual(expected);
    }
  );

  it.each(BUILD_CASES)('build identity: %s', (_name, input, expected) => {
    expect(
      collectBuildIdentityChecks(input).map(({ label, status, detail }) => ({
        label,
        status,
        detail,
      }))
    ).toEqual(expected);
  });
});

const EVERY_ROW: readonly CheckResult[] = [
  ...CASES.map((testCase) => testCase.row),
  ...BUILD_CASES.flatMap(([, input]) => collectBuildIdentityChecks(input)),
];

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

describe('core doctor checks, keys', () => {
  it('sends keys the English dictionary has a template for, on every row', () => {
    for (const row of EVERY_ROW) {
      const templates: Readonly<Record<string, string | undefined>> = MACHINE_CHECK_TEMPLATES_EN;
      expect(
        [row.labelKey, row.detailKey].map((key) => (key ? templates[key] !== undefined : false)),
        `(row "${row.label}"): expected labelKey ${row.labelKey} and detailKey ${row.detailKey} to be English templates`
      ).toEqual([true, true]);
    }
  });

  it('gives each row exactly the params its two templates use', () => {
    for (const row of EVERY_ROW) {
      const templates: Readonly<Record<string, string | undefined>> = MACHINE_CHECK_TEMPLATES_EN;
      const used = [
        ...placeholdersOf(templates[row.labelKey as string] as string),
        ...placeholdersOf(templates[row.detailKey as string] as string),
      ];
      // `slot` also words the label, so one param can serve both templates.
      expect(
        Object.keys(row.params ?? {}).sort(),
        `(params of "${row.label}" / ${row.detailKey}): expected exactly the placeholders ${[...new Set(used)].sort().join(', ')}`
      ).toEqual([...new Set(used)].sort());
    }
  });

  it('exercises every core template, so none is dead and none goes unpinned', () => {
    const sent = new Set(EVERY_ROW.flatMap((row) => [row.labelKey, row.detailKey]));
    // The other sections' templates are exercised by doctor-sections-english.test.ts.
    const unsent = Object.keys(MACHINE_DOCTOR_TEMPLATES_EN).filter(
      (key) => key.startsWith('core.') && !sent.has(key)
    );
    expect(unsent, '(core templates no row sends)').toEqual([]);
  });

  it('names the directory rows by the same label key whatever the outcome', () => {
    const rows = CASES.slice(0, 4).map((testCase) => testCase.row);
    expect(rows.map((row) => [row.labelKey, row.detailKey])).toEqual([
      ['core.label.homeDirectory', 'core.detail.directoryWritable'],
      ['core.label.logsDirectory', 'core.detail.directoryNotWritable'],
      ['core.label.runDirectory', 'core.detail.directoryWillBeCreated'],
      ['core.label.homeDirectory', 'core.detail.directoryParentNotWritable'],
    ]);
  });

  it('carries the slot in params and keeps the OS error out of the key', () => {
    const row = checkRuntimeSlot(slotProbe({ slot: 'remote', error: 'is not valid JSON' }));

    expect(row.labelKey).toBe('core.label.runtimeSlot');
    expect(row.detailKey).toBe('core.detail.runtimeSlotUnreadable');
    expect(row.params).toEqual({
      slot: 'remote',
      file: 'runtime.json',
      directory: '/home/u/.mango/runtime/host',
      error: 'is not valid JSON',
      command: 'mangostudio-runtime setup --slot remote',
    });
  });

  it('sends numbers as decimal text, which is all the wire schema accepts', () => {
    expect(checkInstance(STATE, true).params).toEqual({ pid: '7', port: '4000' });
  });
});
