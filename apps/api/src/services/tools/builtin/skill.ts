/**
 * Built-in tool: skill
 * Lazy-loads Agent Skill content. Skill names and descriptions are advertised
 * in the system prompt; this tool pulls a skill's full SKILL.md instructions —
 * or one of its bundled resource files — into context on demand.
 */

import { getDb } from '../../../db/database';
import {
  loadSkillBody,
  loadSkillFile,
  type SkillBodyResult,
  type SkillFileResult,
} from '../../../modules/skills/application/skill-content';
import { SKILL_TOOL_NAME } from '../../../modules/skills/domain/skill';
import { getOptionalString, getRequiredString } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';

export { SKILL_TOOL_NAME };

const definition = {
  name: SKILL_TOOL_NAME,
  description:
    'Loads the full instructions of an installed skill. Call this with a skill name from ' +
    '<available-skills> before performing a task that matches its description. Pass "file" ' +
    'to read one of the bundled resource files listed in the skill instructions.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name exactly as listed in <available-skills>.',
      },
      file: {
        type: ['string', 'null'],
        description:
          'Path of a bundled resource file, relative to the skill directory ' +
          '(e.g. "reference.md"). Pass null to load the skill instructions.',
      },
    },
    required: ['name', 'file'],
    additionalProperties: false,
  },
};

// biome-ignore lint/suspicious/useAwait: tool executors are async by contract
async function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<SkillBodyResult | SkillFileResult> {
  const name = getRequiredString(args.name, 'name');
  const file = getOptionalString(args.file, 'file');
  const db = getDb();
  return file
    ? loadSkillFile(db, context.userId, name, file)
    : loadSkillBody(db, context.userId, name);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Skills',
      description: 'Allows the AI to load installed Agent Skills and their bundled files.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {},
      parameterDescriptors: [],
    },
    execute,
  });
}
