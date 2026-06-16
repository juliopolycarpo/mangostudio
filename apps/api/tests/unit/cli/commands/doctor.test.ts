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
      log: () => undefined,
      exit: (code) => {
        exited = code;
      },
    });

    expect(exited).toBe(1);
  });
});
