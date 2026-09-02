import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestHubLogFile, tailLines } from '../../../src/cli/log-tail';

describe('tailLines', () => {
  it('returns the last lines and says whether more exist', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual({ lines: ['b', 'c'], truncated: true });
    expect(tailLines('a\r\nb', 5)).toEqual({ lines: ['a', 'b'], truncated: false });
    expect(tailLines('', 5)).toEqual({ lines: [], truncated: false });
    expect(tailLines('\uFEFFfirst\r\n', 5)).toEqual({ lines: ['first'], truncated: false });
  });
});

describe('latestHubLogFile', () => {
  it('picks the newest hub log and ignores installer logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-logs-'));
    try {
      await writeFile(join(dir, 'server-20260101-000000.log'), 'old');
      await writeFile(join(dir, 'service.log'), 'new');
      await writeFile(join(dir, 'install-run.log'), 'ignored');
      await utimes(join(dir, 'server-20260101-000000.log'), 1_000, 1_000);
      await utimes(join(dir, 'service.log'), 2_000, 2_000);
      expect(await latestHubLogFile(dir)).toBe(join(dir, 'service.log'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing directory', async () => {
    expect(await latestHubLogFile('/nonexistent/mango/logs')).toBeNull();
  });
});
