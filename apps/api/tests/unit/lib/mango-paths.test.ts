import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getHomeMangoDir } from '../../../src/lib/config';
import {
  ensureRuntimeDirs,
  getLogsDir,
  getPidFilePath,
  getRunDir,
  getServerLogPath,
} from '../../../src/lib/mango-paths';

describe('mango-paths', () => {
  it('anchors logs and run dirs under ~/.mango', () => {
    const home = getHomeMangoDir();

    expect(getLogsDir()).toBe(join(home, 'logs'));
    expect(getRunDir()).toBe(join(home, 'run'));
    expect(getPidFilePath()).toBe(join(home, 'run', 'server.json'));
  });

  it('builds a timestamped log filename under the logs dir', () => {
    const path = getServerLogPath(1_700_000_000_000);

    expect(path.startsWith(join(getLogsDir(), 'server-'))).toBe(true);
    expect(path).toMatch(/server-\d{8}-\d{6}\.log$/);
  });

  it('creates the logs and run directories idempotently', async () => {
    await ensureRuntimeDirs();
    await ensureRuntimeDirs();

    expect(existsSync(getLogsDir())).toBe(true);
    expect(existsSync(getRunDir())).toBe(true);
  });
});
