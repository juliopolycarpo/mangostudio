/**
 * Compatibility adapter from the five-kind library matrix to the established
 * SkillDescriptor contract consumed by prompts, tools, and capability checks.
 *
 * Chat prompt skills remain a hub-machine concern: this adapter always discovers
 * against the local environment and never grows an `environmentId` parameter.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LibraryInstance, LibraryLocationId } from '@mangostudio/shared/library';
import { getLibraryLocation } from '@mangostudio/shared/library/host';
import { parseMarkdownFrontmatter } from '@mangostudio/shared/markdown';
import type { SkillDescriptor, SkillSource } from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getConfig } from '../../../lib/config';
import { RegularFileReadError, readRegularFileUtf8 } from '../../../lib/safe-file';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import {
  discoverLibraryResources,
  resetLibraryDiscoveryCache,
} from '../../library/application/library-discovery';
import { createLibraryPathEnv } from '../../library/infrastructure/location-probe';
import { isValidSkillSlug, skillKey } from '../domain/skill';
import { listSavedSkillSettings } from '../infrastructure/skill-settings-repository';

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
export const SKILL_FILE_NAME = 'SKILL.md';

/** Highest precedence first for legacy MangoStudio skill consumers. */
const SKILL_SOURCE_PRECEDENCE: ReadonlyArray<SkillSource> = ['mango', 'agents', 'claude'];

const SOURCE_BY_LOCATION_ID: Readonly<Partial<Record<LibraryLocationId, SkillSource>>> = {
  'mango-skills': 'mango',
  'agents-skills': 'agents',
  'claude-skills': 'claude',
};

export type ThirdPartySkillSource = Exclude<SkillSource, 'mango'>;

let thirdPartyDirOverrides: Partial<Record<ThirdPartySkillSource, string>> | null = null;

/**
 * Resolves through the library registry so this adapter and the library matrix
 * never disagree about where a source lives: the registry honours
 * `CLAUDE_CONFIG_DIR`, which a hardcoded `~/.claude/skills` would ignore.
 */
function registrySkillDir(source: ThirdPartySkillSource, ...fallbackParts: string[]): string {
  const locationId = source === 'agents' ? 'agents-skills' : 'claude-skills';
  return (
    getLibraryLocation(locationId)?.resolvePath(createLibraryPathEnv()) ??
    join(homedir(), ...fallbackParts)
  );
}

export function getThirdPartySkillDirs(): Record<ThirdPartySkillSource, string> {
  return {
    agents: thirdPartyDirOverrides?.agents ?? registrySkillDir('agents', '.agents', 'skills'),
    claude: thirdPartyDirOverrides?.claude ?? registrySkillDir('claude', '.claude', 'skills'),
  };
}

export function setThirdPartySkillDirsForTest(
  overrides: Partial<Record<ThirdPartySkillSource, string>> | null
): void {
  thirdPartyDirOverrides = overrides;
}

export type ScannedSkill = Omit<SkillDescriptor, 'enabled' | 'shadowed'>;

export async function listSkills(
  db: Kysely<Database>,
  userId: string,
  now: () => number = Date.now
): Promise<SkillDescriptor[]> {
  const appSettings = await getAppSettings(db, userId);
  const thirdPartyDirs = getThirdPartySkillDirs();
  const [resources, savedSettings] = await Promise.all([
    discoverLibraryResources(db, userId, {
      settings: appSettings,
      now,
      kinds: ['skill'],
      locationPathOverrides: {
        'mango-skills': getConfig().skills.dir,
        'agents-skills': thirdPartyDirs.agents,
        'claude-skills': thirdPartyDirs.claude,
      },
    }),
    listSavedSkillSettings(db, userId),
  ]);

  return resources
    .filter((resource) => resource.ref.kind === 'skill')
    .flatMap((resource) => {
      const mangoCoverage = resource.coverage.find(
        (coverage) => coverage.targetId === 'mangostudio'
      );
      return resource.instances.flatMap((instance) => {
        const source = SOURCE_BY_LOCATION_ID[instance.locationId];
        if (!source || (!instance.valid && instance.invalidReason === 'unexpected-entry-type')) {
          return [];
        }

        const key = skillKey(source, resource.ref.slug);
        return [
          {
            ...adaptInstance(source, resource.ref.slug, instance),
            enabled: savedSettings.get(key) ?? true,
            shadowed: mangoCoverage?.effectiveLocationId !== instance.locationId,
          },
        ];
      });
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

export async function listUsableSkills(
  db: Kysely<Database>,
  userId: string,
  now: () => number = Date.now
): Promise<SkillDescriptor[]> {
  const skills = await listSkills(db, userId, now);
  return skills.filter((skill) => skill.valid && skill.enabled && !skill.shadowed);
}

export function resetSkillsCache(): void {
  resetLibraryDiscoveryCache();
}

/**
 * Retained as a pure compatibility helper for callers that already have
 * descriptors. Library discovery itself resolves precedence per target.
 */
export function resolveWinnersBySlug(skills: ReadonlyArray<ScannedSkill>): Map<string, string> {
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

/**
 * A healthy instance already carries everything a descriptor needs: discovery
 * enforces the same frontmatter rules for `kind: 'skill'` that `describeSkill`
 * does, and its result is memoized per turn. Only the failure path re-reads, to
 * turn a stable `invalidReason` back into the message this contract promises.
 */
function adaptInstance(source: SkillSource, slug: string, instance: LibraryInstance): ScannedSkill {
  if (!instance.valid) return describeSkill(source, slug, instance.path);
  return {
    key: skillKey(source, slug),
    slug,
    source,
    path: instance.path,
    name: instance.title ?? slug,
    description: instance.description ?? '',
    valid: true,
  };
}

export function describeSkill(source: SkillSource, slug: string, path: string): ScannedSkill {
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
