import { describe, expect, it } from 'bun:test';
import { runDoctor } from '../../../../src/cli/commands/doctor';
import type { FsProbe } from '../../../../src/cli/doctor-checks';
import type { MangoConfig } from '../../../../src/lib/config';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const ALL_OK: FsProbe = { exists: () => true, isWritable: () => true };
const NOTHING: FsProbe = { exists: () => false, isWritable: () => false };

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
      { all: false, cursorProbe: false },
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
      { all: false, cursorProbe: false },
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
      { all: false, cursorProbe: false },
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
      { all: true, cursorProbe: false },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Cursor Node');
    expect(text).toContain('Cursor sidecar');
  });

  it('appends a probe row when --cursor-probe and the chain is ready', async () => {
    const lines: string[] = [];

    await runDoctor(
      { all: true, cursorProbe: true },
      {
        ...makeDoctorDeps(),
        log: (msg) => lines.push(msg),
      }
    );

    const text = lines.join('\n');
    expect(text).toContain('Cursor probe');
    expect(text).toContain('auth rejected probe key');
  });
});
