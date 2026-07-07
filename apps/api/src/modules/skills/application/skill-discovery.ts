/**
 * Skill discovery: scans configured skill source directories for
 * `<slug>/SKILL.md` entries and produces descriptors. Malformed skills are
 * flagged invalid instead of thrown so one broken directory never hides the
 * rest, and a short-lived memo keeps the per-turn prompt listing and tool
 * executions within the same turn from re-reading disk.
 *
 * The native `~/.mango/skills` source is always scanned. The third-party
 * `~/.agents/skills` and `~/.claude/skills` directories are opt-in through
 * app-settings (`skillSources`); when enabled, their skills are listed
 * alongside mango skills with `mango > agents > claude` precedence — a
 * lower-precedence copy is flagged `shadowed` and never advertised or loaded.
 */

import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillSourcesSettings } from '@mangostudio/shared/app-settings';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import type {
  SkillDescriptor,
  SkillSource,
  SkillSourceState,
  SkillSourcesState,
} from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getConfig } from '../../../lib/config';
import { RegularFileReadError, readRegularFileUtf8 } from '../../../lib/safe-file';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { isValidSkillSlug, skillKey } from '../domain/skill';
import { listSavedSkillSettings } from '../infrastructure/skill-settings-repository';

export type { SkillSourceState, SkillSourcesSettings, SkillSourcesState };

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const SKILL_FILE_NAME = 'SKILL.md';

const CACHE_TTL_MS = 2_000;

/** Source precedence: mango > agents > claude. Lower index wins. */
const SOURCE_PRECEDENCE: ReadonlyArray<SkillSource> = ['mango', 'agents', 'claude'];

const AGENTS_SKILLS_SUBPATH = join('.agents', 'skills');
const CLAUDE_SKILLS_SUBPATH = join('.claude', 'skills');

/**
 * Resolves the user home directory. Prefers `process.env.HOME` so test sandboxes
 * can redirect the fixed third-party skill dirs at runtime; falls back to the
 * OS-reported home for production use where HOME is stable.
 */
function resolveHome(): string {
  return process.env.HOME ?? homedir();
}

function agentsSkillsDir(): string {
  return join(resolveHome(), AGENTS_SKILLS_SUBPATH);
}

function claudeSkillsDir(): string {
  return join(resolveHome(), CLAUDE_SKILLS_SUBPATH);
}

interface SkillSourceDir {
  readonly source: SkillSource;
  readonly dir: string;
}

interface SkillsCache {
  readonly scannedAt: number;
  readonly dirsKey: string;
  readonly skills: SkillDescriptor[];
}

let cache: SkillsCache | null = null;

function getActiveSkillSourceDirs(skillSources: SkillSourcesSettings): SkillSourceDir[] {
  const dirs: SkillSourceDir[] = [{ source: 'mango', dir: getConfig().skills.dir }];
  if (skillSources.agents) dirs.push({ source: 'agents', dir: agentsSkillsDir() });
  if (skillSources.claude) dirs.push({ source: 'claude', dir: claudeSkillsDir() });
  return dirs;
}

function buildSkillSourcesState(skillSources: SkillSourcesSettings): SkillSourcesState {
  return {
    agents: describeSourceState(skillSources.agents, agentsSkillsDir()),
    claude: describeSourceState(skillSources.claude, claudeSkillsDir()),
  };
}

function describeSourceState(enabled: boolean, dir: string): SkillSourceState {
  return { enabled, path: dir, exists: dirExists(dir) };
}

function dirExists(dir: string): boolean {
  try {
    return existsSync(dir);
  } catch {
    return false;
  }
}

/**
 * Lists every discovered skill descriptor (valid and invalid), alphabetical by
 * key, with `enabled` and `shadowed` resolved from the user's app-settings and
 * per-skill overrides. Also returns the source toggle state for the list
 * response. // Usage: const { skills, sources } = await listSkills(db, userId);
 */
export async function listSkills(
  db: Kysely<Database>,
  userId: string,
  now: () => number = Date.now
): Promise<{ skills: SkillDescriptor[]; sources: SkillSourcesState }> {
  const appSettings = await getAppSettings(db, userId);
  const sources = buildSkillSourcesState(appSettings.skillSources);
  const activeDirs = getActiveSkillSourceDirs(appSettings.skillSources);
  const scanned = scanSkillDirs(activeDirs, now);
  const savedSettings = await listSavedSkillSettings(db, userId);
  const skills = applySettingsAndShadowing(scanned, savedSettings);
  return { skills, sources };
}

/**
 * Lists only skills that are usable this turn: valid, enabled, and not
 * shadowed by a higher-precedence source. // Usage: const skills = await listUsableSkills(db, userId);
 */
export async function listUsableSkills(
  db: Kysely<Database>,
  userId: string,
  now: () => number = Date.now
): Promise<SkillDescriptor[]> {
  const { skills } = await listSkills(db, userId, now);
  return skills.filter((skill) => skill.valid && skill.enabled && !skill.shadowed);
}

/** Drops the discovery memo — for tests. // Usage: resetSkillsCache() */
export function resetSkillsCache(): void {
  cache = null;
}

function scanSkillDirs(
  activeDirs: ReadonlyArray<SkillSourceDir>,
  now: () => number
): SkillDescriptor[] {
  const dirsKey = activeDirs.map((entry) => `${entry.source}:${entry.dir}`).join('\n');
  const timestamp = now();

  if (cache && cache.dirsKey === dirsKey && timestamp - cache.scannedAt < CACHE_TTL_MS) {
    return cache.skills;
  }

  const skills = activeDirs
    .flatMap((sourceDir) => scanSourceDir(sourceDir))
    .sort((left, right) => left.key.localeCompare(right.key));
  cache = { scannedAt: timestamp, dirsKey, skills };
  return skills;
}

function applySettingsAndShadowing(
  scanned: ReadonlyArray<SkillDescriptor>,
  savedSettings: ReadonlyMap<string, boolean>
): SkillDescriptor[] {
  const winnerBySlug = new Map<string, SkillSource>();
  for (const skill of scanned) {
    const currentWinner = winnerBySlug.get(skill.slug);
    if (!currentWinner || precedenceRank(skill.source) < precedenceRank(currentWinner)) {
      winnerBySlug.set(skill.slug, skill.source);
    }
  }

  return scanned.map((skill) => ({
    ...skill,
    enabled: savedSettings.has(skill.key) ? (savedSettings.get(skill.key) ?? true) : true,
    shadowed: winnerBySlug.get(skill.slug) !== skill.source,
  }));
}

function precedenceRank(source: SkillSource): number {
  return SOURCE_PRECEDENCE.indexOf(source);
}

function scanSourceDir({ source, dir }: SkillSourceDir): SkillDescriptor[] {
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

function describeSkill(source: SkillSource, slug: string, path: string): SkillDescriptor {
  const base = { key: skillKey(source, slug), slug, source, path, enabled: true, shadowed: false };

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
  base: Pick<SkillDescriptor, 'key' | 'slug' | 'source' | 'path' | 'enabled' | 'shadowed'>,
  error: string
): SkillDescriptor {
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
