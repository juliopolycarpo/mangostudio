/**
 * Skill content loading for the `skill` builtin tool: the SKILL.md body plus a
 * bundled-file listing, and strictly-sandboxed reads of individual bundled
 * files. Path resolution never leaves the skill directory, including through
 * symlinks.
 */

import { type Dirent, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import type { SkillDescriptor } from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { RegularFileReadError, readRegularFileUtf8 } from '../../../lib/safe-file';
import { SkillError } from '../domain/skill';
import { listUsableSkills, MAX_SKILL_FILE_BYTES, SKILL_FILE_NAME } from './skill-discovery';

const MAX_LISTED_FILES = 100;
const MAX_LISTING_DEPTH = 3;
const MAX_NAMES_IN_ERROR = 64;

export interface SkillBodyResult {
  readonly name: string;
  readonly description: string;
  /** Absolute skill directory; bundled script paths resolve against this. */
  readonly baseDir: string;
  /** SKILL.md body with frontmatter stripped. */
  readonly body: string;
  /** Bundled files relative to baseDir (depth and count bounded). */
  readonly files: string[];
  readonly filesTruncated: boolean;
}

export interface SkillFileResult {
  readonly name: string;
  readonly file: string;
  readonly content: string;
  readonly truncated: boolean;
}

/** Loads a skill's instructions and bundled-file listing. // Usage: await loadSkillBody('pdf-tools', db, userId) */
export async function loadSkillBody(
  name: string,
  db: Kysely<Database>,
  userId: string
): Promise<SkillBodyResult> {
  const skill = await findSkillByName(name, db, userId);
  const markdown = readSkillText(join(skill.path, SKILL_FILE_NAME));
  const listing = listBundledFiles(skill.path);

  return {
    name: skill.name,
    description: skill.description,
    baseDir: skill.path,
    body: parseMarkdownFrontmatter(markdown.content).body.trim(),
    files: listing.files,
    filesTruncated: listing.truncated,
  };
}

/** Reads one bundled file, confined to the skill directory. // Usage: await loadSkillFile('pdf-tools', 'reference.md', db, userId) */
export async function loadSkillFile(
  name: string,
  file: string,
  db: Kysely<Database>,
  userId: string
): Promise<SkillFileResult> {
  const skill = await findSkillByName(name, db, userId);
  const filePath = resolveInsideSkillDir(skill.path, file);
  const content = readSkillText(filePath);

  return {
    name: skill.name,
    file,
    content: content.content,
    truncated: content.truncated,
  };
}

async function findSkillByName(
  name: string,
  db: Kysely<Database>,
  userId: string
): Promise<SkillDescriptor> {
  const skills = await listUsableSkills(db, userId);
  const skill = skills.find((candidate) => candidate.name === name);
  if (skill) return skill;

  const validNames = skills
    .slice(0, MAX_NAMES_IN_ERROR)
    .map((candidate) => candidate.name)
    .join(', ');
  throw new SkillError(
    validNames
      ? `Unknown skill "${name}". Available skills: ${validNames}`
      : `Unknown skill "${name}". No skills are installed.`,
    404,
    'NOT_FOUND'
  );
}

/**
 * Resolves `file` strictly inside `skillDir`, rejecting absolute paths, `..`
 * traversal, and symlinks that point outside the skill directory.
 */
function resolveInsideSkillDir(skillDir: string, file: string): string {
  const baseDir = resolve(skillDir);
  const resolved = resolve(baseDir, file);
  assertInsideDir(baseDir, resolved);

  // A symlink at or below the requested path could still escape; compare the
  // real locations too. ENOENT falls through to the reader's not-found error.
  try {
    assertInsideDir(realpathSync(baseDir), realpathSync(resolved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return resolved;
}

function assertInsideDir(baseDir: string, candidate: string): void {
  const relativePath = relative(baseDir, candidate);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new SkillError(
      'Skill file path must stay inside the skill directory.',
      422,
      'VALIDATION'
    );
  }
}

function readSkillText(filePath: string): { content: string; truncated: boolean } {
  try {
    const result = readRegularFileUtf8(filePath, {
      maxBytes: MAX_SKILL_FILE_BYTES,
      truncateOversize: true,
    });
    return { content: result.content, truncated: result.truncated };
  } catch (error) {
    if (error instanceof RegularFileReadError) {
      if (error.reason === 'not-found') {
        throw new SkillError('Skill file not found.', 404, 'NOT_FOUND');
      }
      throw new SkillError('Skill file is not a readable regular file.', 422, 'VALIDATION');
    }
    throw error;
  }
}

function listBundledFiles(skillDir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  const visit = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_LISTING_DEPTH) return;
    for (const entry of readDirEntriesOrEmpty(dir)) {
      if (files.length >= MAX_LISTED_FILES) {
        truncated = true;
        return;
      }
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth === MAX_LISTING_DEPTH) {
          truncated = true;
          continue;
        }
        visit(join(dir, entry.name), relativePath, depth + 1);
        continue;
      }
      if (entry.isFile() && relativePath !== SKILL_FILE_NAME) {
        files.push(relativePath);
      }
    }
  };

  visit(skillDir, '', 1);
  return { files: files.sort((left, right) => left.localeCompare(right)), truncated };
}

function readDirEntriesOrEmpty(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
