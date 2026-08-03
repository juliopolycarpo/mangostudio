import { describe, expect, it } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeRemoveSlotBytesScript } from '../../../../src/modules/environments/domain/runtime-push';
import { pruneRuntimeCache } from '../../../../src/modules/environments/domain/runtime-release-fetch';

describe('runtimeRemoveSlotBytesScript', () => {
  it('keeps consent files and deletes version dirs', () => {
    const script = runtimeRemoveSlotBytesScript('wsl');
    expect(script).toContain('runtime.json');
    expect(script).toContain('credentials.json');
    expect(script).toContain('rm -rf');
    expect(script).toContain('"$HOME/.mango/runtime/wsl"');
  });
});

describe('pruneRuntimeCache', () => {
  it('keeps current and previous version directories only', async () => {
    const root = join(tmpdirUnique(), 'runtime-cache');
    for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
      const dir = join(root, version);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'marker'), version);
    }

    await pruneRuntimeCache(join(root, '1.2.0'), '1.2.0');
    const remaining = (await readdir(root)).sort();
    expect(remaining).toEqual(['1.1.0', '1.2.0']);
  });
});

function tmpdirUnique(): string {
  return join(
    process.env.TMPDIR ?? '/tmp',
    `mango-cache-gc-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
