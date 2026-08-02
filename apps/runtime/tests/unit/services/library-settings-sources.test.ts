import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { readSettingsSources } from '../../../src/services/library/settings-sources';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-settings-sources-'));
  tempDirs.push(path);
  return path;
}

function pathEnv(homeDir: string): PathEnv {
  return {
    platform: process.platform,
    homeDir,
    env: { CODEX_HOME: join(homeDir, '.codex') },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('readSettingsSources', () => {
  it('reports a missing rules-dsl directory as absent, not present-empty', async () => {
    const home = await createTempDir();
    // No .codex/rules directory — ENOENT must not look like an empty present source.
    const result = readSettingsSources(pathEnv(home));
    const rules = result.sources.find((source) => source.locationId === 'codex-permission-rules');

    expect(rules).toEqual({ locationId: 'codex-permission-rules', present: false });
  });

  it('reports an existing empty rules-dsl directory as present with no rules', async () => {
    const home = await createTempDir();
    await mkdir(join(home, '.codex', 'rules'), { recursive: true });

    const result = readSettingsSources(pathEnv(home));
    const rules = result.sources.find((source) => source.locationId === 'codex-permission-rules');

    expect(rules).toEqual({
      locationId: 'codex-permission-rules',
      present: true,
      sizeBytes: 0,
      rules: [],
    });
  });

  it('reports a missing regular settings file as absent', async () => {
    const home = await createTempDir();
    const result = readSettingsSources(pathEnv(home));
    const settings = result.sources.find((source) => source.locationId === 'codex-settings');

    expect(settings).toEqual({ locationId: 'codex-settings', present: false });
  });

  it('reads .rules files from a present rules-dsl directory', async () => {
    const home = await createTempDir();
    const rulesDir = join(home, '.codex', 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, 'default.rules'), 'allow *');

    const result = readSettingsSources(pathEnv(home));
    const rules = result.sources.find((source) => source.locationId === 'codex-permission-rules');

    expect(rules).toMatchObject({
      locationId: 'codex-permission-rules',
      present: true,
      rules: [{ name: 'default.rules', content: 'allow *' }],
    });
  });
});
