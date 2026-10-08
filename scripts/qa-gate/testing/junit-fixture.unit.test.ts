import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { fakeFiles } from './junit-fixture';

describe('fakeFiles', () => {
  it('matches native filesystem path spelling and records the original read', async () => {
    const secondKey = `${join('shards', 'test-shard-2')}//report.xml`;
    const files = { 'shards/test-shard-1/report.xml': 'report', [secondKey]: 'second report' };
    const fs = fakeFiles(files);
    const request = `${join('shards', 'test-shard-1')}//report.xml`;
    const secondRequest = 'shards/test-shard-2/report.xml';

    expect(await fs.readText(request)).toBe('report');
    expect(await fs.readText(secondRequest)).toBe('second report');
    expect(fs.reads).toEqual([request, secondRequest]);
    expect(Object.keys(files)).toEqual(['shards/test-shard-1/report.xml', secondKey]);
  });

  it('keeps an absent normalized path missing', async () => {
    const fs = fakeFiles({ [join('shards', 'test-shard-1', 'report.xml')]: 'report' });
    const request = 'shards/test-shard-1//absent.xml';

    expect(await fs.readText(request)).toBeNull();
    expect(fs.reads).toEqual([request]);
  });
});
