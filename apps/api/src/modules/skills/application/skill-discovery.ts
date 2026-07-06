/**
 * Skill discovery: scans configured skill source directories for
 * `<slug>/SKILL.md` entries and produces descriptors. Malformed skills are
 * flagged invalid instead of thrown so one broken directory never hides the
 * rest, and a short-lived memo keeps the per-turn prompt listing and tool
 * executions within the same turn from re-reading disk.
 */

import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import type { SkillDescriptor, SkillSource } from '@mangostudio/shared/skills';
import { getConfig } from '../../../lib/config';
import { RegularFileReadError, readRegularFileUtf8 } from '../../../lib/safe-file';
import { isValidSkillSlug, skillKey } from '../domain/skill';

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const SKILL_FILE_NAME = 'SKILL.md';

const CACHE_TTL_MS = 2_000;

interface SkillSourceDir {
  readonly source: SkillSource;
  readonly dir: string;
}

/** Plural already so plan 012's third-party sources only append entries. */
function getSkillSourceDirs(): SkillSourceDir[] {
  return [{ source: 'mango', dir: getConfig().skills.dir }];
}

interface SkillsCache {
  readonly scannedAt: number;
  readonly dirsKey: string;
  readonly skills: SkillDescriptor[];
}

let cache: SkillsCache | null = null;

/**
 * Lists every discovered skill descriptor (valid and invalid), alphabetical by
 * key. Results are memoized for a short TTL; the cache is also keyed on the
 * source dirs so a config swap (tests) is picked up immediately.
 * // Usage: const skills = listSkills();
 */
export function listSkills(now: () => number = Date.now): SkillDescriptor[] {
  const sourceDirs = getSkillSourceDirs();
  const dirsKey = sourceDirs.map((entry) => `${entry.source}:${entry.dir}`).join('\n');
  const timestamp = now();

  if (cache && cache.dirsKey === dirsKey && timestamp - cache.scannedAt < CACHE_TTL_MS) {
    return cache.skills;
  }

  const skills = sourceDirs
    .flatMap((sourceDir) => scanSourceDir(sourceDir))
    .sort((left, right) => left.key.localeCompare(right.key));
  cache = { scannedAt: timestamp, dirsKey, skills };
  return skills;
}

/** Lists only skills that are usable this turn. // Usage: listUsableSkills() */
export function listUsableSkills(now: () => number = Date.now): SkillDescriptor[] {
  return listSkills(now).filter((skill) => skill.valid && skill.enabled);
}

/** Drops the discovery memo — for tests. // Usage: resetSkillsCache() */
export function resetSkillsCache(): void {
  cache = null;
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
  const base = { key: skillKey(source, slug), slug, source, path, enabled: true };

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
  const name = frontmatter.name;
  const description = frontmatter.description;

  if (typeof name !== 'string' || name.trim() !== slug) {
    return invalidSkill(base, 'Frontmatter "name" must match the skill directory name.');
  }
  if (typeof description !== 'string' || !description.trim()) {
    return invalidSkill(base, 'Frontmatter "description" must be a non-empty string.');
  }

  return { ...base, name: name.trim(), description: description.trim(), valid: true };
}

function invalidSkill(
  base: Pick<SkillDescriptor, 'key' | 'slug' | 'source' | 'path' | 'enabled'>,
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
