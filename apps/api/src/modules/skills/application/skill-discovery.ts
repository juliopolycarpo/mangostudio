/**
 * Skill discovery: scans configured skill source directories for
 * `<slug>/SKILL.md` entries and produces descriptors. Malformed skills are
 * flagged invalid instead of thrown so one broken directory never hides the
 * rest, and a short-lived memo keeps the per-turn prompt listing and tool
 * executions within the same turn from re-reading disk. User settings (source
 * toggles and per-skill flags) are read fresh on every call — they are cheap
 * DB hits and correctness-critical — and applied on top of the memoized scan.
 */

import { type Dirent, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillSourceSettings } from '@mangostudio/shared/app-settings';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import type { SkillDescriptor, SkillSource } from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getConfig } from '../../../lib/config';
import { RegularFileReadError, readRegularFileUtf8 } from '../../../lib/safe-file';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { isValidSkillSlug, skillKey } from '../domain/skill';
import { listSavedSkillSettings } from '../infrastructure/skill-settings-repository';

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const SKILL_FILE_NAME = 'SKILL.md';

const CACHE_TTL_MS = 2_000;

/** Highest precedence first: on slug collisions the earlier source wins. */
const SKILL_SOURCE_PRECEDENCE: ReadonlyArray<SkillSource> = ['mango', 'agents', 'claude'];

export type ThirdPartySkillSource = Exclude<SkillSource, 'mango'>;

let thirdPartyDirOverrides: Partial<Record<ThirdPartySkillSource, string>> | null = null;

/**
 * Fixed third-party skill directories (mirrors the rule-file resolver's fixed
 * paths). Arbitrary extra directories are intentionally out of scope.
 * // Usage: const { agents, claude } = getThirdPartySkillDirs();
 */
export function getThirdPartySkillDirs(): Record<ThirdPartySkillSource, string> {
  return {
    agents: thirdPartyDirOverrides?.agents ?? join(homedir(), '.agents', 'skills'),
    claude: thirdPartyDirOverrides?.claude ?? join(homedir(), '.claude', 'skills'),
  };
}

/** Redirects the fixed third-party dirs — for tests. // Usage: setThirdPartySkillDirsForTest({ agents: dir }) */
export function setThirdPartySkillDirsForTest(
  overrides: Partial<Record<ThirdPartySkillSource, string>> | null
): void {
  thirdPartyDirOverrides = overrides;
}

interface SkillSourceDir {
  readonly source: SkillSource;
  readonly dir: string;
}

/** Enabled source dirs in precedence order; `mango` is always on. */
function getSkillSourceDirs(sources: SkillSourceSettings): SkillSourceDir[] {
  const thirdPartyDirs = getThirdPartySkillDirs();
  const dirs: SkillSourceDir[] = [{ source: 'mango', dir: getConfig().skills.dir }];
  if (sources.agents) dirs.push({ source: 'agents', dir: thirdPartyDirs.agents });
  if (sources.claude) dirs.push({ source: 'claude', dir: thirdPartyDirs.claude });
  return dirs;
}

/** Descriptor fields produced by the pure filesystem scan, before settings. */
type ScannedSkill = Omit<SkillDescriptor, 'enabled' | 'shadowed'>;

interface SkillsCache {
  readonly scannedAt: number;
  readonly skills: ScannedSkill[];
}

/**
 * Memoized scans keyed by the source-dir signature, so users on different
 * source toggles don't evict each other's entry (the set of distinct keys is
 * bounded by the source combinations, at most a handful).
 */
const cacheByDirs = new Map<string, SkillsCache>();

/**
 * Lists every skill discovered in the user's enabled sources (valid and
 * invalid), alphabetical by key, with per-skill `enabled` and slug-collision
 * `shadowed` flags resolved. The filesystem scan is memoized for a short TTL
 * and keyed on the source dirs so a config swap (tests) or source toggle is
 * picked up immediately. // Usage: const skills = await listSkills(db, userId);
 */
export async function listSkills(
  db: Kysely<Database>,
  userId: string,
  now: () => number = Date.now
): Promise<SkillDescriptor[]> {
  const appSettings = await getAppSettings(db, userId);
  const scanned = scanSkillSources(getSkillSourceDirs(appSettings.skillSources), now);
  const savedSettings = await listSavedSkillSettings(db, userId);
  const winnerBySlug = resolveWinnersBySlug(scanned);

  return scanned.map((skill) => ({
    ...skill,
    enabled: savedSettings.get(skill.key) ?? true,
    shadowed: winnerBySlug.get(skill.slug) !== skill.key,
  }));
}

/**
 * Lists only skills that are usable this turn: valid, enabled, and not
 * shadowed by a higher-precedence source.
 * // Usage: await listUsableSkills(db, userId)
 */
export async function listUsableSkills(
  db: Kysely<Database>,
  userId: string,
  now: () => number = Date.now
): Promise<SkillDescriptor[]> {
  const skills = await listSkills(db, userId, now);
  return skills.filter((skill) => skill.valid && skill.enabled && !skill.shadowed);
}

/** Drops the discovery memo — for tests. // Usage: resetSkillsCache() */
export function resetSkillsCache(): void {
  cacheByDirs.clear();
}

/**
 * Maps each slug to the key of its winning source (mango > agents > claude).
 * Deliberately ignores `valid` and per-skill `enabled`: a disabled or broken
 * winner still shadows lower-precedence copies, so precedence stays
 * predictable instead of flipping with toggles.
 */
function resolveWinnersBySlug(skills: ReadonlyArray<ScannedSkill>): Map<string, string> {
  const winners = new Map<string, string>();
  for (const source of SKILL_SOURCE_PRECEDENCE) {
    for (const skill of skills) {
      if (skill.source === source && !winners.has(skill.slug)) {
        winners.set(skill.slug, skill.key);
      }
    }
  }
  return winners;
}

function scanSkillSources(sourceDirs: SkillSourceDir[], now: () => number): ScannedSkill[] {
  const dirsKey = sourceDirs.map((entry) => `${entry.source}:${entry.dir}`).join('\n');
  const timestamp = now();

  const cached = cacheByDirs.get(dirsKey);
  if (cached && timestamp - cached.scannedAt < CACHE_TTL_MS) {
    return cached.skills;
  }

  const skills = sourceDirs
    .flatMap((sourceDir) => scanSourceDir(sourceDir))
    .sort((left, right) => left.key.localeCompare(right.key));
  cacheByDirs.set(dirsKey, { scannedAt: timestamp, skills });
  return skills;
}

function scanSourceDir({ source, dir }: SkillSourceDir): ScannedSkill[] {
  return readSkillsDirEntries(dir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => describeSkill(source, entry.name, join(dir, entry.name)));
}

function readSkillsDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // A missing skills directory just means no skills installed yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function describeSkill(source: SkillSource, slug: string, path: string): ScannedSkill {
  const base = { key: skillKey(source, slug), slug, source, path };

  if (!isValidSkillSlug(slug)) {
    return invalidSkill(base, 'Directory name is not a valid skill slug.');
  }

  let markdown: string;
  try {
    markdown = readRegularFileUtf8(join(path, SKILL_FILE_NAME), {
      maxBytes: MAX_SKILL_FILE_BYTES,
    }).content;
  } catch (error) {
    return invalidSkill(base, describeReadFailure(error));
  }

  const { frontmatter } = parseMarkdownFrontmatter(markdown);
  // The frontmatter parser coerces unquoted scalars, so a numeric-only slug like
  // `2048` arrives here as a number; accept scalar values so valid slugs are not
  // rejected for failing the `typeof === 'string'` check.
  const name = frontmatterScalarString(frontmatter.name)?.trim();
  const description = frontmatterScalarString(frontmatter.description)?.trim();

  if (name !== slug) {
    return invalidSkill(base, 'Frontmatter "name" must match the skill directory name.');
  }
  if (!description) {
    return invalidSkill(base, 'Frontmatter "description" must be a non-empty string.');
  }

  return { ...base, name, description, valid: true };
}

/** Renders a scalar frontmatter value as a string; arrays/undefined yield undefined. */
function frontmatterScalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function invalidSkill(
  base: Pick<ScannedSkill, 'key' | 'slug' | 'source' | 'path'>,
  error: string
): ScannedSkill {
  return { ...base, name: base.slug, description: '', valid: false, error };
}

function describeReadFailure(error: unknown): string {
  if (error instanceof RegularFileReadError) {
    switch (error.reason) {
      case 'not-found':
        return `${SKILL_FILE_NAME} not found in the skill directory.`;
      case 'not-regular-file':
        return `${SKILL_FILE_NAME} is not a regular file.`;
      case 'too-large':
        return `${SKILL_FILE_NAME} exceeds ${MAX_SKILL_FILE_BYTES} bytes.`;
      default:
        return `${SKILL_FILE_NAME} is not readable.`;
    }
  }
  return `${SKILL_FILE_NAME} is not readable.`;
}
