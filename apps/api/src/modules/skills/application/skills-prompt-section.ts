/**
 * Builds the `<available-skills>` system-prompt section that advertises skill
 * names and one-line descriptions. The full skill body is only pulled into
 * context when the model calls the `skill` tool, keeping the per-turn token
 * cost bounded.
 */

import type { SkillDescriptor } from '@mangostudio/shared/skills';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { SKILL_TOOL_NAME } from '../domain/skill';
import { listUsableSkills } from './skill-discovery';

const MAX_LISTED_SKILLS = 64;
const MAX_DESCRIPTION_CHARS = 1_024;

const SKILLS_INSTRUCTION =
  'The following skills extend your capabilities. When a task matches a skill ' +
  'description, call the `skill` tool with that skill name to load its full ' +
  'instructions before doing the task.';

/**
 * Renders the prompt section for usable skills, or undefined when there is
 * nothing to advertise. // Usage: buildSkillsPromptSection(listUsableSkills())
 */
export function buildSkillsPromptSection(
  skills: ReadonlyArray<SkillDescriptor>
): string | undefined {
  const usable = skills.filter((skill) => skill.valid && skill.enabled && !skill.shadowed);
  if (usable.length === 0) return undefined;

  const lines = [...usable]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_LISTED_SKILLS)
    .map((skill) => `- ${skill.name} — ${clampDescription(skill.description)}`);

  return ['<available-skills>', SKILLS_INSTRUCTION, ...lines, '</available-skills>'].join('\n');
}

/**
 * Appends the skills advertisement to a turn's system prompt when the `skill`
 * tool is allowed and at least one usable skill exists; otherwise returns the
 * prompt unchanged. Shared by the primary turn pipeline and the subagent
 * runner so both advertise skills consistently with their own tool profiles.
 * // Usage: effectiveSystemPrompt = await appendSkillsPromptSection(db, userId, effectiveSystemPrompt, allowedToolNames);
 */
export async function appendSkillsPromptSection(
  db: Kysely<Database>,
  userId: string,
  systemPrompt: string | undefined,
  allowedToolNames: ReadonlySet<string>
): Promise<string | undefined> {
  if (!allowedToolNames.has(SKILL_TOOL_NAME)) return systemPrompt;
  const section = buildSkillsPromptSection(await listUsableSkills(db, userId));
  if (!section) return systemPrompt;
  return systemPrompt ? `${systemPrompt}\n\n${section}` : section;
}

function clampDescription(description: string): string {
  const singleLine = description.replaceAll(/\s+/g, ' ').trim();
  if (singleLine.length <= MAX_DESCRIPTION_CHARS) return singleLine;
  return `${singleLine.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
}
