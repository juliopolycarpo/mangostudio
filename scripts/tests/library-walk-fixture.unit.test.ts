import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_COUNTS,
  FIXTURE_SCENARIOS,
  type FixtureEntry,
  materializeFixture,
  planFixture,
} from '../bench/library-fixture';

const leaves = (plan: readonly FixtureEntry[]) => plan.filter((entry) => entry.kind !== 'dir');

describe('scripts/bench/library-fixture', () => {
  const scratch: string[] = [];
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('wide puts every file in one directory of one skill', () => {
    const plan = planFixture('wide', { count: 5 });
    const files = plan.filter((entry) => entry.path.startsWith('.mango/skills/wide/f'));
    expect(files.map((entry) => entry.path)).toEqual(
      [0, 1, 2, 3, 4].map((index) => `.mango/skills/wide/f${index}.md`)
    );
    expect(plan.some((entry) => entry.path === '.mango/skills/wide/SKILL.md')).toBe(true);
  });

  test('aliases points every link at one shared file', () => {
    const plan = planFixture('aliases', { count: 4, links: 3 });
    const links = plan.filter((entry) => entry.kind === 'symlink');
    expect(links).toHaveLength(3);
    expect(links.every((entry) => entry.target === '../files/f0.md')).toBe(true);
    expect(plan.filter((entry) => entry.path.includes('/files/f'))).toHaveLength(4);
  });

  test('dirs gives each directory exactly one file', () => {
    const plan = planFixture('dirs', { count: 3 });
    expect(plan.filter((entry) => entry.kind === 'dir' && /\/d\d+$/.test(entry.path))).toHaveLength(
      3
    );
    expect(plan.filter((entry) => /\/d\d+\/f\.md$/.test(entry.path))).toHaveLength(3);
  });

  test('normal gives each skill an entrypoint and four references', () => {
    const plan = planFixture('normal', { count: 2 });
    expect(leaves(plan)).toHaveLength(2 * (1 + 4));
  });

  test('every default stays inside the walk caps it is meant to exercise', () => {
    // `aliases` and `dirs` must stay under the 10 000-leaf cap, `wide` far over it.
    expect(leaves(planFixture('aliases', { count: DEFAULT_COUNTS.aliases })).length).toBeLessThan(
      10_000
    );
    expect(leaves(planFixture('dirs', { count: DEFAULT_COUNTS.dirs })).length).toBeLessThan(10_000);
    expect(DEFAULT_COUNTS.wide).toBeGreaterThan(10_000 * 10);
    expect(FIXTURE_SCENARIOS).toEqual(['wide', 'aliases', 'dirs', 'normal']);
  });

  test('refuses an unknown scenario or a bad count with the value and the shape', () => {
    expect(() => planFixture('huge')).toThrow(
      'expected scenario wide | aliases | dirs | normal | received: "huge"'
    );
    expect(() => planFixture('wide', { count: 0 })).toThrow(
      'expected --count to be a positive integer | received: 0'
    );
    expect(() => planFixture('aliases', { links: -1 })).toThrow(
      'expected --links to be a non-negative integer | received: -1'
    );
  });

  test('materialize writes directories, files and symlinks under the home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'library-fixture-test-'));
    scratch.push(root);
    await materializeFixture(planFixture('aliases', { count: 2, links: 1 }), join(root, 'home'));
    const base = join(root, 'home', '.mango', 'skills', 'aliases');
    expect((await readdir(join(base, 'files'))).sort()).toEqual(['f0.md', 'f1.md']);
    expect(await readFile(join(base, 'files', 'f1.md'), 'utf8')).toBe('file 1\n');
    expect((await lstat(join(base, 'links', 'l0.md'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(base, 'links', 'l0.md'))).toBe(join('..', 'files', 'f0.md'));
    expect(await readFile(join(base, 'links', 'l0.md'), 'utf8')).toBe('file 0\n');
  });
});
