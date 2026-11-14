import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODE_HEALTH_CACHE_DIR,
  codeHealthCacheGeneration,
  createCodeHealthCommand,
  planCodeHealthCache,
  staleCodeHealthCaches,
} from '../lib/code-health';
import { readText } from './support/read-text';

// A local `bun run check` reuses Knip's per-file cache. CI never does, and a
// new Knip or a new configuration starts a fresh cache instead of trusting an
// old one.

const GENERATION = codeHealthCacheGeneration('6.44.2', '{"workspaces":{}}');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-code-health-cache-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repository root holding only what the cache plan reads. */
function installKnip(version: unknown, config = '{"workspaces":{}}'): void {
  mkdirSync(join(root, 'node_modules/knip'), { recursive: true });
  writeFileSync(join(root, 'node_modules/knip/package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'knip.json'), config);
}

describe('codeHealthCacheGeneration', () => {
  test('is twelve hex characters and stable for the same inputs', () => {
    expect(GENERATION).toMatch(/^[0-9a-f]{12}$/);
    expect(codeHealthCacheGeneration('6.44.2', '{"workspaces":{}}')).toBe(GENERATION);
  });

  test('changes with the Knip version and with the configuration', () => {
    expect(codeHealthCacheGeneration('6.44.3', '{"workspaces":{}}')).not.toBe(GENERATION);
    expect(codeHealthCacheGeneration('6.44.2', '{"workspaces":{"a":{}}}')).not.toBe(GENERATION);
  });

  test('does not confuse a version suffix with a configuration prefix', () => {
    expect(codeHealthCacheGeneration('6.44.2{', '}')).not.toBe(
      codeHealthCacheGeneration('6.44.2', '{}')
    );
  });
});

describe('createCodeHealthCommand', () => {
  test('without a generation it is the package script as written', () => {
    expect(createCodeHealthCommand('default', null)).toEqual(['bun', 'run', 'code-health']);
    expect(createCodeHealthCommand('production', null)).toEqual([
      'bun',
      'run',
      'code-health:production',
    ]);
  });

  test('with a generation each mode caches in a directory of its own', () => {
    expect(createCodeHealthCommand('default', GENERATION)).toEqual([
      'bun',
      'run',
      'code-health',
      '--cache',
      '--cache-location',
      `.mango/knip-cache/${GENERATION}/default`,
    ]);
    expect(createCodeHealthCommand('production', GENERATION).at(-1)).toBe(
      `.mango/knip-cache/${GENERATION}/production`
    );
  });

  test('names scripts the root manifest defines', () => {
    const manifest = JSON.parse(readText('package.json')) as { scripts: Record<string, string> };
    for (const mode of ['default', 'production'] as const) {
      const script = createCodeHealthCommand(mode, null)[2];
      expect(manifest.scripts[script], `(code-health): expected a root script: ${script}`).toMatch(
        /^knip /
      );
    }
  });
});

describe('staleCodeHealthCaches', () => {
  test('lists every generation but the current one', () => {
    expect(staleCodeHealthCaches([GENERATION, 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'], GENERATION)).toEqual(
      ['.mango/knip-cache/aaaaaaaaaaaa', '.mango/knip-cache/bbbbbbbbbbbb']
    );
  });

  test('lists nothing when only the current generation exists', () => {
    expect(staleCodeHealthCaches([GENERATION], GENERATION)).toEqual([]);
  });
});

describe('planCodeHealthCache', () => {
  test('names the generation of the installed Knip and its configuration', () => {
    installKnip('6.44.2');
    expect(planCodeHealthCache(root, {})).toEqual({ generation: GENERATION, stale: [] });
  });

  test('lists earlier generations for removal', () => {
    installKnip('6.44.2');
    mkdirSync(join(root, CODE_HEALTH_CACHE_DIR, GENERATION), { recursive: true });
    mkdirSync(join(root, CODE_HEALTH_CACHE_DIR, 'aaaaaaaaaaaa'), { recursive: true });
    expect(planCodeHealthCache(root, {})).toEqual({
      generation: GENERATION,
      stale: ['.mango/knip-cache/aaaaaaaaaaaa'],
    });
  });

  test.each([['true'], ['1']])('is uncached when CI is %p', (ci) => {
    installKnip('6.44.2');
    mkdirSync(join(root, CODE_HEALTH_CACHE_DIR, 'aaaaaaaaaaaa'), { recursive: true });
    expect(planCodeHealthCache(root, { CI: ci })).toEqual({ generation: null, stale: [] });
  });

  test('a blank CI does not turn the cache off', () => {
    installKnip('6.44.2');
    expect(planCodeHealthCache(root, { CI: '  ' }).generation).toBe(GENERATION);
  });

  test.each([
    ['Knip is not installed', () => writeFileSync(join(root, 'knip.json'), '{}')],
    [
      'the configuration is missing',
      () => {
        mkdirSync(join(root, 'node_modules/knip'), { recursive: true });
        writeFileSync(join(root, 'node_modules/knip/package.json'), '{"version":"6.44.2"}');
      },
    ],
    ['the Knip manifest has no version string', () => installKnip(6)],
    [
      'the Knip manifest is not JSON',
      () => {
        installKnip('6.44.2');
        writeFileSync(join(root, 'node_modules/knip/package.json'), 'not json');
      },
    ],
  ])('is uncached when %s', (_name, arrange) => {
    arrange();
    expect(planCodeHealthCache(root, {})).toEqual({ generation: null, stale: [] });
  });
});

describe('bun run check and clean', () => {
  test('check builds both scans from the planned cache and removes stale generations', () => {
    const checkScript = readText('scripts/check.ts');
    expect(checkScript).toContain('const codeHealthCache = planCodeHealthCache(ROOT_DIR);');
    expect(checkScript).toContain('await removePaths(codeHealthCache.stale);');
    expect(checkScript).toContain("createCodeHealthCommand('default', codeHealthCache.generation)");
    expect(checkScript).toContain(
      "createCodeHealthCommand('production', codeHealthCache.generation)"
    );
  });

  test('clean removes the cache', () => {
    expect(readText('scripts/clean.ts')).toContain(`'${CODE_HEALTH_CACHE_DIR}',`);
  });

  test('the cache directory is ignored by Git', () => {
    const ignored = Bun.spawnSync(['git', 'check-ignore', '-q', `${CODE_HEALTH_CACHE_DIR}/x/y`], {
      cwd: join(import.meta.dir, '..', '..'),
    });
    expect(
      ignored.exitCode,
      `(code-health): expected ${CODE_HEALTH_CACHE_DIR} ignored by Git | received: check-ignore exit ${ignored.exitCode}`
    ).toBe(0);
  });
});
