import { describe, expect, it } from 'bun:test';
import { runDoctor } from '../../../../src/cli/commands/doctor';
import type { FsProbe } from '../../../../src/cli/doctor-checks';
import type { BuildInfo } from '../../../../src/lib/build-info';
import type { MangoConfig } from '../../../../src/lib/config';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const ALL_OK: FsProbe = { exists: () => true, isWritable: () => true };
const NOTHING: FsProbe = { exists: () => false, isWritable: () => false };
const BUILD_INFO: BuildInfo = {
  gitSha: 'abc123',
  gitDirty: false,
  builtAt: '2026-07-04T12:00:00.000Z',
  buildType: 'production',
};

const FAILING_NODE_CHAIN = [
  {
    link: 'node' as const,
    ok: false,
    detail: 'Node.js 22.13+ is required for Cursor SDK Agents (found v20.0.0).',
  },
  {
    link: 'sidecar' as const,
    ok: false,
    detail: 'Cursor SDK sidecar script is missing at /tmp/cursor-sidecar/run-agent.mjs.',
  },
  { link: 'sdk' as const, ok: true, detail: '@cursor/sdk complete' },
  {
    link: 'native' as const,
    ok: true,
    detail: '@cursor/sdk-linux-x64 (present)',
  },
];

const HEALTHY_CHAIN = [
  { link: 'node' as const, ok: true, detail: '/usr/bin/node (v22.13.0, meets >= 22.13)' },
  { link: 'sidecar' as const, ok: true, detail: '/app/cursor-sidecar/run-agent.mjs (present)' },
  { link: 'sdk' as const, ok: true, detail: '@cursor/sdk complete' },
  { link: 'native' as const, ok: true, detail: '@cursor/sdk-linux-x64 (present)' },
];

function makeConfig(): MangoConfig {
  return {
    server: { host: 'localhost', port: 3001 },
    frontend: { host: 'localhost', port: 5173 },
    database: { path: '/data/db.sqlite' },
    uploads: { dir: '/data/uploads' },
    images: { dir: '/data/images' },
    agents: { dir: '/data/agents' },
    auth: { secret: 'x'.repeat(32), url: 'http://localhost:3001' },
    security: { trustProxy: false },
    cursor: { workspaceDir: '', sidecarScriptPath: '', nodePath: '' },
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
    getCursorDoctorChain: () => Promise.resolve(HEALTHY_CHAIN),
    isCursorConfigured: () => false,
    probeCursorRuntime: () =>
      Promise.resolve({
        ok: true,
        detail: 'validate_api_key reached SDK (auth rejected probe key)',
      }),
    listChatGptConnectors: () => [],
    collectChatGptChecks: () =>
      Promise.resolve([
        { label: 'ChatGPT secrets', status: 'ok' as const, detail: 'secret store reachable' },
      ]),
    getBuildInfo: () => BUILD_INFO,
    getCheckoutBuildInfo: () => BUILD_INFO,
    readFrontendBuildInfo: () => BUILD_INFO,
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
      { all: false, cursorProbe: false, chatgptRefresh: false },
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
    expect(text).not.toContain('Cursor Node');
    expect(exited).toBe(-1);
  });

  it('exits 1 when a required directory check fails', async () => {
    let exited = -1;

    await runDoctor(
      { all: false, cursorProbe: false, chatgptRefresh: false },
      {
        ...makeDoctorDeps({ fs: NOTHING }),
        exit: (code) => {
          exited = code;
        },
      }
    );

    expect(exited).toBe(1);
  });

  it('includes per-link Cursor checks when a connector is configured', async () => {
    const lines: string[] = [];
    let exited = -1;

    await runDoctor(
      { all: false, cursorProbe: false, chatgptRefresh: false },
      {
        ...makeDoctorDeps({
          isCursorConfigured: () => true,
          getCursorDoctorChain: () => Promise.resolve(FAILING_NODE_CHAIN),
        }),
        log: (msg) => lines.push(msg),
        exit: (code) => {
          exited = code;
        },
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Cursor Node');
    expect(text).toContain('Cursor sidecar');
    expect(text).toContain('Cursor SDK');
    expect(text).toContain('Cursor native');
    expect(text).toContain('sidecar script is missing');
    expect(text).toContain('2 failure(s)');
    expect(exited).toBe(1);
  });

  it('runs Cursor checks with --all even without a configured connector', async () => {
    const lines: string[] = [];

    await runDoctor(
      { all: true, cursorProbe: false, chatgptRefresh: false },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Cursor Node');
    expect(text).toContain('Cursor sidecar');
  });

  it('skips ChatGPT checks when no connector exists and --all is absent', async () => {
    const lines: string[] = [];

    await runDoctor(
      { all: false, cursorProbe: false, chatgptRefresh: false },
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
      { all: false, cursorProbe: false, chatgptRefresh: true },
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
      { all: true, cursorProbe: false, chatgptRefresh: false },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    expect(lines.join('\n')).toContain('ChatGPT secrets');
  });

  it('appends a probe row when --cursor-probe and the chain is ready', async () => {
    const lines: string[] = [];

    await runDoctor(
      { all: true, cursorProbe: true, chatgptRefresh: false },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Cursor probe');
    expect(text).toContain('auth rejected probe key');
  });

  it('warns when checkout and frontend build stamps differ from the server', async () => {
    const lines: string[] = [];

    await runDoctor(
      { all: false, cursorProbe: false, chatgptRefresh: false },
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
});
