import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DOCTOR_ARGS } from '../../../../src/cli/args';
import { runDoctor } from '../../../../src/cli/commands/doctor';
import type { FsProbe } from '../../../../src/cli/doctor-checks';
import type { BuildInfo } from '../../../../src/lib/build-info';
import type { MangoConfig } from '../../../../src/lib/config';
import type { InstallOriginProbe } from '../../../../src/modules/updates/domain/install-origin';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const ALL_OK: FsProbe = { exists: () => true, isWritable: () => true };
const NOTHING: FsProbe = { exists: () => false, isWritable: () => false };
const BUILD_INFO: BuildInfo = {
  gitSha: 'abc123',
  gitDirty: false,
  builtAt: '2026-07-04T12:00:00.000Z',
  buildType: 'production',
};

const INSTALL_ORIGIN_RECORD = JSON.stringify({
  origin: 'installer',
  channel: 'stable',
  version: '0.1.1',
});

/** A self-managed install with a readable `install-origin.json` — not legacy. */
function selfManagedProbe(overrides: Partial<InstallOriginProbe> = {}): InstallOriginProbe {
  return {
    platform: 'linux',
    env: {},
    execPath: '/home/j/.mango/dist/0.1.1/mangostudio',
    version: '0.1.1',
    standalone: true,
    container: false,
    home: '/home/j',
    readFile: (path) =>
      path === '/home/j/.mango/dist/install-origin.json' ? INSTALL_ORIGIN_RECORD : null,
    ...overrides,
  };
}

/** A self-managed dist root predating `install-origin.json` — legacy. */
function legacyInstallProbe(): InstallOriginProbe {
  return selfManagedProbe({ readFile: () => null });
}

function makeConfig(): MangoConfig {
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
    checkpoints: { dir: '/data/checkpoints' },
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
  };
}

function makeDoctorDeps(overrides: Record<string, unknown> = {}) {
  return {
    loadConfig: makeConfig,
    fs: ALL_OK,
    frontendDir: () => '/app',
    controller: new FakeProcessController(),
    readState: () => Promise.resolve(null),
    isCursorConfigured: () => false,
    probeRuntimeBinary: () =>
      Promise.resolve({ path: null, present: false, version: null, error: null }),
    listChatGptConnectors: () => [],
    collectChatGptChecks: () =>
      Promise.resolve([
        { label: 'ChatGPT secrets', status: 'ok' as const, detail: 'secret store reachable' },
      ]),
    getBuildInfo: () => BUILD_INFO,
    getCheckoutBuildInfo: () => BUILD_INFO,
    readFrontendBuildInfo: () => BUILD_INFO,
    collectSkillsChecks: () => [
      { label: 'Skills config', status: 'ok' as const, detail: '/data/skills (from default)' },
    ],
    listMcpServers: () => [],
    collectMcpChecks: () => Promise.resolve([]),
    collectEnvironmentChecks: () => Promise.resolve([]),
    collectLibraryChecks: () => Promise.resolve([]),
    installOriginProbe: () => selfManagedProbe(),
    checker: { readCached: () => null, check: () => Promise.resolve(null) },
    isTty: () => false,
    now: () => 0,
    log: () => undefined,
    exit: () => undefined,
    ...overrides,
  };
}

describe('runDoctor', () => {
  it('prints a checklist and does not exit when healthy', async () => {
    const lines: string[] = [];
    let exited = -1;

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
        exit: (code) => {
          exited = code;
        },
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('MangoStudio doctor');
    expect(text).toContain('0 failure(s)');
    expect(text).not.toContain('Cursor');
    expect(exited).toBe(-1);
  });

  it('surfaces a runtime binary that drifted from the hub release', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          probeRuntimeBinary: () =>
            Promise.resolve({
              path: '/app/mangostudio-runtime',
              present: true,
              version: '0.0.1',
              error: null,
            }),
        }),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Runtime binary');
    expect(text).toContain('v0.0.1 does not match hub');
    expect(text).toContain('1 warning(s), 0 failure(s).');
  });

  it('exits 1 when a required directory check fails', async () => {
    let exited = -1;

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({ fs: NOTHING }),
        exit: (code) => {
          exited = code;
        },
      }
    );

    expect(exited).toBe(1);
  });

  it('skips ChatGPT checks when no connector exists and --all is absent', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).not.toContain('ChatGPT secrets');
  });

  it('includes ChatGPT checks when a connector exists and forwards the refresh flag', async () => {
    const lines: string[] = [];
    const receivedRefresh: boolean[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS, chatgptRefresh: true },
      {
        ...makeDoctorDeps({
          listChatGptConnectors: () => [{ id: 'connector-1' }],
          collectChatGptChecks: (_config: unknown, _connectors: unknown, refresh: boolean) => {
            receivedRefresh.push(refresh);
            return Promise.resolve([
              {
                label: 'ChatGPT secrets',
                status: 'ok' as const,
                detail: 'secret store reachable',
              },
            ]);
          },
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('ChatGPT secrets');
    expect(receivedRefresh).toEqual([true]);
  });

  it('runs ChatGPT checks with --all even without a connector', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS, all: true },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('ChatGPT secrets');
  });

  // The deprecation's second telemetry question — is a Cursor key still around
  // — answered where an operator will look. A warning, not a failure: nothing
  // is broken, there is just something left to migrate.
  it('warns when a deprecated Cursor connector is still configured', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({ isCursorConfigured: () => true }),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Cursor connector');
    expect(text).toContain('Deprecated provider');
  });

  it('warns when a Cursor connector exists in secret_metadata', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          listCursorConnectors: () => [{ id: 'legacy-cursor', provider: 'cursor' }],
        }),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Cursor connector');
    expect(text).toContain('Deprecated provider');
  });

  it('says nothing about Cursor when no connector is configured', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS, all: true },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).not.toContain('Cursor');
  });

  it('warns when checkout and frontend build stamps differ from the server', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          getCheckoutBuildInfo: () => ({ ...BUILD_INFO, gitSha: 'checkout123' }),
          readFrontendBuildInfo: () => ({ ...BUILD_INFO, gitSha: 'frontend123' }),
        }),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('checkout checkout123 differs from server abc123');
    expect(text).toContain('frontend frontend123 differs from server abc123');
    expect(text).toContain('2 warning(s), 0 failure(s).');
  });

  it('reports the embedded frontend and its build stamp when assets are compiled in', async () => {
    const embedDir = mkdtempSync(join(tmpdir(), 'doctor-embed-'));
    const buildInfoPath = join(embedDir, 'build-info.json');
    writeFileSync(buildInfoPath, JSON.stringify(BUILD_INFO));

    const lines: string[] = [];
    try {
      await runDoctor(
        { ...DEFAULT_DOCTOR_ARGS },
        {
          ...makeDoctorDeps({
            getEmbeddedFrontend: () => ({
              '/index.html': join(embedDir, 'index.html'),
              '/build-info.json': buildInfoPath,
            }),
            // Embedded assets must win over any filesystem sidecar stamp.
            readFrontendBuildInfo: () => ({ ...BUILD_INFO, gitSha: 'stale-sidecar' }),
          }),
          log: (msg) => lines.push(msg),
        }
      );
    } finally {
      rmSync(embedDir, { recursive: true, force: true });
    }

    const text = lines.join('\n');
    expect(text).toContain('embedded in binary (2 files)');
    expect(text).not.toContain('stale-sidecar');
    expect(text).toContain('0 warning(s), 0 failure(s).');
  });

  it('always renders the skills section', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      { ...makeDoctorDeps(), log: (msg) => lines.push(msg) }
    );

    expect(lines.join('\n')).toContain('Skills config');
  });

  it('skips the MCP section when no servers exist and --all is absent', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          collectMcpChecks: () =>
            Promise.resolve([{ label: 'MCP github', status: 'ok' as const, detail: 'stdio' }]),
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).not.toContain('MCP github');
  });

  it('exits 1 when an MCP command check fails', async () => {
    let exited = -1;

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          listMcpServers: () => [{ slug: 'github' }] as never,
          collectMcpChecks: () =>
            Promise.resolve([
              { label: 'MCP github', status: 'ok' as const, detail: 'stdio, enabled' },
              {
                label: 'MCP github command',
                status: 'fail' as const,
                detail: 'no command configured (stdio MCP servers require a command)',
              },
            ]),
        }),
        exit: (code) => {
          exited = code;
        },
      }
    );

    expect(exited).toBe(1);
  });

  it('renders the MCP section and forwards probe + running flags when servers exist', async () => {
    const lines: string[] = [];
    const received: Array<{ probe: boolean; serverRunning: boolean }> = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS, probe: true },
      {
        ...makeDoctorDeps({
          readState: () => Promise.resolve({ pid: 4242, port: 3001, startedAt: 0 } as never),
          controller: { isAlive: () => true } as never,
          listMcpServers: () => [{ slug: 'github' }] as never,
          collectMcpChecks: (
            _rows: unknown,
            options: { probe: boolean; serverRunning: boolean }
          ) => {
            received.push(options);
            return Promise.resolve([
              { label: 'MCP github', status: 'ok' as const, detail: 'stdio, enabled' },
            ]);
          },
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('MCP github');
    expect(received).toEqual([{ probe: true, serverRunning: true }]);
  });
});

describe('runDoctor Installed via / Update rows', () => {
  // `getVersion()` reads `VERSION` from the environment directly, the same as
  // every other doctor check that reports it — under `bun test` that is unset,
  // which reads as a dev build and skips the Update row before it reaches
  // anything these tests inject. A real version makes the row's own logic
  // reachable.
  let savedVersion: string | undefined;

  beforeEach(() => {
    savedVersion = process.env.VERSION;
    process.env.VERSION = '0.1.1';
  });

  afterEach(() => {
    if (savedVersion === undefined) delete process.env.VERSION;
    else process.env.VERSION = savedVersion;
  });

  it('includes both rows in --json', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS, json: true },
      {
        ...makeDoctorDeps({
          checker: {
            readCached: () => ({
              channel: 'stable',
              currentVersion: '0.1.1',
              latestVersion: '0.2.0',
              updateAvailable: true,
              checkedAt: 3_600_000,
            }),
            check: () => Promise.resolve(null),
          },
        }),
        log: (msg) => lines.push(msg),
      }
    );

    const document = JSON.parse(lines.join('\n')) as {
      checks: Array<{ label: string; status: string; detail: string }>;
    };
    const labels = document.checks.map((check) => check.label);
    expect(labels).toContain('Installed via');
    expect(labels).toContain('Update');
    expect(document.checks.find((check) => check.label === 'Update')).toMatchObject({
      status: 'warn',
      detail: '0.2.0 available — run: mangostudio upgrade',
    });
  });

  it('reports checks disabled', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          loadConfig: () => ({ ...makeConfig(), updates: { check: false, channel: null } }),
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('checks disabled');
  });

  it('reports up to date with hours since the last check', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          checker: {
            readCached: () => ({
              channel: 'stable',
              currentVersion: '0.1.1',
              updateAvailable: false,
              checkedAt: 0,
            }),
            check: () => Promise.resolve(null),
          },
          now: () => 3 * 3_600_000,
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('up to date (0.1.1, checked 3h ago)');
  });

  it('reports not checked yet when nothing is cached', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      { ...makeDoctorDeps(), log: (msg) => lines.push(msg) }
    );

    expect(lines.join('\n')).toContain('not checked yet');
  });

  it('reports a failed check', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          checker: {
            readCached: () => ({
              channel: 'stable',
              currentVersion: '0.1.1',
              updateAvailable: false,
              checkedAt: 0,
              error: 'DNS lookup failed',
            }),
            check: () => Promise.resolve(null),
          },
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('check failed (DNS lookup failed)');
  });

  it('performs the check itself on a TTY when nothing fresh is cached', async () => {
    const lines: string[] = [];
    let checkCalls = 0;

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          isTty: () => true,
          checker: {
            readCached: () => null,
            check: () => {
              checkCalls += 1;
              return Promise.resolve({
                channel: 'stable',
                currentVersion: '0.1.1',
                latestVersion: '0.2.0',
                updateAvailable: true,
                checkedAt: 0,
              });
            },
          },
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(checkCalls).toBe(1);
    expect(lines.join('\n')).toContain('0.2.0 available');
  });

  it('never checks itself off a TTY, even with nothing cached', async () => {
    const lines: string[] = [];
    let checkCalls = 0;

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({
          checker: {
            readCached: () => null,
            check: () => {
              checkCalls += 1;
              return Promise.resolve(null);
            },
          },
        }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(checkCalls).toBe(0);
    expect(lines.join('\n')).toContain('not checked yet');
  });

  it('notes a legacy self-managed dist root', async () => {
    const lines: string[] = [];

    await runDoctor(
      { ...DEFAULT_DOCTOR_ARGS },
      {
        ...makeDoctorDeps({ installOriginProbe: () => legacyInstallProbe() }),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('legacy layout, run mangostudio upgrade to migrate');
  });
});
