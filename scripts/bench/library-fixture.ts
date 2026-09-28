/**
 * Fixture plans for the library-walk benchmark (`library-walk.ts`).
 *
 * A plan is plain data — every directory, file and symlink under a fake home,
 * relative to it — so the layout is testable without touching a disk and the
 * same plan yields a byte-identical tree for the Base and the Head build.
 * All skills live under `.mango/skills`, the location the runtime scans first.
 */

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FixtureScenario = 'wide' | 'aliases' | 'dirs' | 'normal';

export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = ['wide', 'aliases', 'dirs', 'normal'];

export type FixtureEntry =
  | { readonly kind: 'dir'; readonly path: string }
  | { readonly kind: 'file'; readonly path: string; readonly text: string }
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string };

export interface FixtureOptions {
  /** Files (`wide`, `aliases`), directories (`dirs`) or skills (`normal`). */
  readonly count?: number;
  /** Extra symlinks onto one shared file (`aliases`). */
  readonly links?: number;
}

/** What `count` means per scenario when the caller names none. */
export const DEFAULT_COUNTS: Readonly<Record<FixtureScenario, number>> = {
  // Far past the 10 000-entry cap, in one directory of one instance.
  wide: 500_000,
  // Distinct canonical files inside the 10 000-leaf cap.
  aliases: 9_000,
  // One file per directory, inside the same cap.
  dirs: 9_000,
  normal: 300,
};

const SKILLS = '.mango/skills';

function skillText(slug: string): string {
  return `---\nname: ${slug}\ndescription: Benchmark skill ${slug}.\n---\nbody of ${slug}\n`;
}

function skillRoot(slug: string): FixtureEntry[] {
  return [
    { kind: 'dir', path: `${SKILLS}/${slug}` },
    { kind: 'file', path: `${SKILLS}/${slug}/SKILL.md`, text: skillText(slug) },
  ];
}

/**
 * The entries of one scenario. Throws on an unknown scenario or a count that
 * is not a positive integer, naming the value and the accepted shape.
 *
 * @example
 * planFixture('dirs', { count: 3 }); // skill `dirs` with d0..d2, one file each
 */
export function planFixture(
  scenario: string,
  options: FixtureOptions = {}
): readonly FixtureEntry[] {
  if (!FIXTURE_SCENARIOS.includes(scenario as FixtureScenario)) {
    throw new Error(
      `expected scenario ${FIXTURE_SCENARIOS.join(' | ')} | received: ${JSON.stringify(scenario)}`
    );
  }
  const known = scenario as FixtureScenario;
  const count = options.count ?? DEFAULT_COUNTS[known];
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`expected --count to be a positive integer | received: ${String(count)}`);
  }
  const links = options.links ?? 50;
  if (!Number.isInteger(links) || links < 0) {
    throw new Error(`expected --links to be a non-negative integer | received: ${String(links)}`);
  }
  const plan = { wide, aliases, dirs, normal }[known];
  return plan(count, links);
}

function wide(count: number): FixtureEntry[] {
  const entries = skillRoot('wide');
  for (let index = 0; index < count; index += 1) {
    entries.push({ kind: 'file', path: `${SKILLS}/wide/f${index}.md`, text: '' });
  }
  return entries;
}

function aliases(count: number, links: number): FixtureEntry[] {
  const entries = skillRoot('aliases');
  const base = `${SKILLS}/aliases`;
  entries.push({ kind: 'dir', path: `${base}/files` }, { kind: 'dir', path: `${base}/links` });
  for (let index = 0; index < count; index += 1) {
    entries.push({ kind: 'file', path: `${base}/files/f${index}.md`, text: `file ${index}\n` });
  }
  for (let index = 0; index < links; index += 1) {
    entries.push({ kind: 'symlink', path: `${base}/links/l${index}.md`, target: '../files/f0.md' });
  }
  return entries;
}

function dirs(count: number): FixtureEntry[] {
  const entries = skillRoot('dirs');
  for (let index = 0; index < count; index += 1) {
    const directory = `${SKILLS}/dirs/d${index}`;
    entries.push(
      { kind: 'dir', path: directory },
      { kind: 'file', path: `${directory}/f.md`, text: `dir ${index}\n` }
    );
  }
  return entries;
}

function normal(count: number): FixtureEntry[] {
  const entries: FixtureEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const slug = `skill-${index}`;
    const base = `${SKILLS}/${slug}`;
    entries.push(...skillRoot(slug), { kind: 'dir', path: `${base}/references` });
    for (let reference = 0; reference < 4; reference += 1) {
      entries.push({
        kind: 'file',
        path: `${base}/references/r${reference}.md`,
        text: `reference ${reference} of ${slug}\n`.repeat(20),
      });
    }
  }
  return entries;
}

/** How many entries write at once; enough to keep the disk busy, few enough to stay under fd limits. */
const WRITE_CONCURRENCY = 64;

/**
 * Writes a plan under `home`. Directories are created first, so files and
 * symlinks can be written in parallel batches.
 *
 * @example
 * await materializeFixture(planFixture('normal', { count: 2 }), '/tmp/bench/home');
 */
export async function materializeFixture(
  plan: readonly FixtureEntry[],
  home: string
): Promise<void> {
  await mkdir(home, { recursive: true });
  for (const entry of plan) {
    if (entry.kind === 'dir') await mkdir(join(home, entry.path), { recursive: true });
  }
  const leaves = plan.filter((entry) => entry.kind !== 'dir');
  for (let start = 0; start < leaves.length; start += WRITE_CONCURRENCY) {
    await Promise.all(
      leaves.slice(start, start + WRITE_CONCURRENCY).map((entry) => writeLeaf(home, entry))
    );
  }
}

async function writeLeaf(home: string, entry: FixtureEntry): Promise<void> {
  const target = join(home, entry.path);
  await mkdir(dirname(target), { recursive: true });
  if (entry.kind === 'file') await writeFile(target, entry.text);
  else if (entry.kind === 'symlink') await symlink(entry.target, target);
}
