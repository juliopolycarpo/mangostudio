import {
  SKILL_SLUG_MAX_LENGTH,
  SKILL_SLUG_PATTERN,
  type SkillSource,
} from '@mangostudio/shared/skills';

/** Name of the builtin tool that lazy-loads skill content. */
export const SKILL_TOOL_NAME = 'skill';

const SKILL_SLUG_REGEX = new RegExp(SKILL_SLUG_PATTERN);
const SKILL_SOURCES: ReadonlyArray<SkillSource> = ['mango', 'agents', 'claude'];

export class SkillError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

/** True when `slug` is a well-formed skill directory name. // Usage: isValidSkillSlug('pdf-tools') */
export function isValidSkillSlug(slug: string): boolean {
  return slug.length <= SKILL_SLUG_MAX_LENGTH && SKILL_SLUG_REGEX.test(slug);
}

/** Builds the stable `<source>:<slug>` skill identity. // Usage: skillKey('mango', 'pdf-tools') */
export function skillKey(source: SkillSource, slug: string): string {
  return `${source}:${slug}`;
}

/** Parses a `<source>:<slug>` key, or null when malformed. // Usage: parseSkillKey('mango:pdf-tools') */
export function parseSkillKey(key: string): { source: SkillSource; slug: string } | null {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1) return null;

  const source = key.slice(0, separatorIndex);
  const slug = key.slice(separatorIndex + 1);
  if (!SKILL_SOURCES.some((known) => known === source) || !isValidSkillSlug(slug)) return null;
  return { source: source as SkillSource, slug };
}
