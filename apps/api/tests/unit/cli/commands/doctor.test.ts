import { describe, expect, it } from 'bun:test';
import { runDoctor } from '../../../../src/cli/commands/doctor';
import type { FsProbe } from '../../../../src/cli/doctor-checks';
import type { MangoConfig } from '../../../../src/lib/config';
import { FakeProcessController } from '../../../support/mocks/fake-process-controller';

const ALL_OK: FsProbe = { exists: () => true, isWritable: () => true };
const NOTHING: FsProbe = { exists: () => false, isWritable: () => false };

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
    cursor: { workspaceDir: '', sidecarScriptPath: '' },
    corsOrigins: [],
    configFilePath: '/data/config.toml',
  };
}

describe('runDoctor', () => {
  it('prints a checklist and does not exit when healthy', async () => {
    const lines: string[] = [];
    let exited = -1;

    await runDoctor({
      loadConfig: makeConfig,
      fs: ALL_OK,
      frontendDir: () => '/app',
      controller: new FakeProcessController(),
      readState: () => Promise.resolve(null),
      detectCursorRuntime: () => Promise.resolve({ available: true, version: 'v22.13.0' }),
      isCursorConfigured: () => false,
      log: (msg) => lines.push(msg),
      exit: (code) => {
        exited = code;
      },
    });

    const text = lines.join('\n');
    expect(text).toContain('MangoStudio doctor');
    expect(text).toContain('0 failure(s)');
    expect(exited).toBe(-1);
  });

  it('exits 1 when a required directory check fails', async () => {
    let exited = -1;

    await runDoctor({
      loadConfig: makeConfig,
      fs: NOTHING,
      frontendDir: () => '/app',
      controller: new FakeProcessController(),
      readState: () => Promise.resolve(null),
      detectCursorRuntime: () => Promise.resolve({ available: true, version: 'v22.13.0' }),
      isCursorConfigured: () => false,
      log: () => undefined,
      exit: (code) => {
        exited = code;
      },
    });

    expect(exited).toBe(1);
  });

  it('fails when Cursor is configured but runtime is unavailable', async () => {
    const lines: string[] = [];
    let exited = -1;

    await runDoctor({
      loadConfig: makeConfig,
      fs: ALL_OK,
      frontendDir: () => '/app',
      controller: new FakeProcessController(),
      readState: () => Promise.resolve(null),
      detectCursorRuntime: () =>
        Promise.resolve({
          available: false,
          reasonCode: 'cursor.version_insufficient',
          reasonParams: { foundVersion: 'v20.0.0' },
        }),
      isCursorConfigured: () => true,
      log: (msg) => lines.push(msg),
      exit: (code) => {
        exited = code;
      },
    });

    const text = lines.join('\n');
    expect(text).toContain('Cursor runtime');
    expect(text).toContain('1 failure(s)');
    expect(exited).toBe(1);
  });

  it('fails when Cursor is configured but the SDK sidecar is missing', async () => {
    const lines: string[] = [];
    let exited = -1;

    await runDoctor({
      loadConfig: makeConfig,
      fs: ALL_OK,
      frontendDir: () => '/app',
      controller: new FakeProcessController(),
      readState: () => Promise.resolve(null),
      detectCursorRuntime: () =>
        Promise.resolve({
          available: false,
          version: 'v22.13.0',
          reasonCode: 'cursor.sidecar_missing',
          reasonParams: {
            sidecarPath: '/tmp/cursor-sidecar/run-agent.mjs',
          },
        }),
      isCursorConfigured: () => true,
      log: (msg) => lines.push(msg),
      exit: (code) => {
        exited = code;
      },
    });

    const text = lines.join('\n');
    expect(text).toContain('Cursor runtime');
    expect(text).toContain('sidecar script is missing');
    expect(text).toContain('1 failure(s)');
    expect(exited).toBe(1);
  });
});
