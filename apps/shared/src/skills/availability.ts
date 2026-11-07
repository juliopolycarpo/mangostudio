import type { SkillDescriptor } from './schemas';

/**
 * Whether a discovered skill can be advertised and loaded by the Hub.
 *
 * @example
 * const availableSkills = skills.filter(isUsableSkill);
 */
export function isUsableSkill(skill: SkillDescriptor): boolean {
  return skill.valid && skill.enabled && !skill.shadowed && !skill.precedenceUnverified;
}
