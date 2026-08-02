import type { ResourceKind } from '@mangostudio/shared/library';
import { SKILL_SLUG_MAX_LENGTH, SKILL_SLUG_PATTERN } from '@mangostudio/shared/skills';

const SKILL_SLUG_REGEX = new RegExp(SKILL_SLUG_PATTERN);

/**
 * Slug rules layered on top of the library-wide pattern, which is deliberately
 * the wider of the two: `My_Skill` is a valid library slug and an invalid skill
 * directory name. Without this seam a directory the old scanner reported as
 * malformed would pass discovery and only fail later, or vanish entirely.
 */
const SLUG_RULES: Partial<Record<ResourceKind, (slug: string) => boolean>> = {
  skill: (slug) => slug.length <= SKILL_SLUG_MAX_LENGTH && SKILL_SLUG_REGEX.test(slug),
};

/** True when `slug` satisfies the extra rules `kind` puts on top of the library pattern. */
export function isValidKindSlug(kind: ResourceKind, slug: string): boolean {
  return SLUG_RULES[kind]?.(slug) ?? true;
}
