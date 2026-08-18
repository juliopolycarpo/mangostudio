import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { resetSkillsCache } from '../../../../src/modules/skills/application/skill-discovery';
import { upsertSkillSettings } from '../../../../src/modules/skills/infrastructure/skill-settings-repository';
import { executeTool, getTool } from '../../../../src/services/tools';
import { register, SKILL_TOOL_NAME } from '../../../../src/services/tools/builtin/skill';
import type { ToolContext } from '../../../../src/services/tools/types';

let skillsDir: string;

const context: ToolContext = { userId: 'user-skill-tool-test', chatId: 'chat-1', parameters: {} };

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-skill-tool-'));
  loadConfigForTest({ skills: { dir: skillsDir } });
  resetSkillsCache();
  register();

  const dir = join(skillsDir, 'pdf-tools');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: pdf-tools\ndescription: Work with PDF files\n---\n\nUse `reference.md` for details.\n',
    'utf8'
  );
  writeFileSync(join(dir, 'reference.md'), 'PDF reference.', 'utf8');
});

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  resetSkillsCache();
});

describe('skill tool', () => {
  it('registers with the expected definition and settings', () => {
    const tool = getTool(SKILL_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.definition.parameters.required).toEqual(['name']);
    expect(tool?.settings.enabledByDefault).toBe(true);
    expect(tool?.settings.canDisable).toBe(true);
  });

  it('loads the skill body, base dir, and file listing without "file"', async () => {
    const result = (await executeTool(SKILL_TOOL_NAME, { name: 'pdf-tools' }, context)) as {
      body: string;
      baseDir: string;
      files: string[];
    };

    expect(result.body).toBe('Use `reference.md` for details.');
    expect(result.baseDir).toBe(join(skillsDir, 'pdf-tools'));
    expect(result.files).toEqual(['reference.md']);
  });

  it('reads an explicit null "file" as absent and loads the skill body', async () => {
    const result = (await executeTool(
      SKILL_TOOL_NAME,
      { name: 'pdf-tools', file: null },
      context
    )) as { body: string };

    expect(result.body).toBe('Use `reference.md` for details.');
  });

  it('rejects a non-string "file" instead of loading the skill body', async () => {
    await expect(
      executeTool(SKILL_TOOL_NAME, { name: 'pdf-tools', file: 42 }, context)
    ).rejects.toThrow('Field "file" must be a string.');
  });

  it('loads a bundled file with "file"', async () => {
    const result = (await executeTool(
      SKILL_TOOL_NAME,
      { name: 'pdf-tools', file: 'reference.md' },
      context
    )) as { content: string; truncated: boolean };

    expect(result.content).toBe('PDF reference.');
    expect(result.truncated).toBe(false);
  });

  it('rejects unknown skills with the valid names listed', async () => {
    await expect(executeTool(SKILL_TOOL_NAME, { name: 'nope' }, context)).rejects.toThrow(
      /Unknown skill "nope". Available skills: pdf-tools/
    );
  });

  it('rejects a skill the user disabled in settings', async () => {
    const disabledContext: ToolContext = {
      ...context,
      userId: 'user-skill-tool-disabled-test',
    };
    await upsertSkillSettings(getDb(), disabledContext.userId, 'mango:pdf-tools', false);

    await expect(
      executeTool(SKILL_TOOL_NAME, { name: 'pdf-tools' }, disabledContext)
    ).rejects.toThrow(/is disabled in settings/);
  });

  it('rejects execution when the tool is disabled', async () => {
    await expect(
      executeTool(SKILL_TOOL_NAME, { name: 'pdf-tools' }, context, {
        enabled: false,
        parameters: {},
      })
    ).rejects.toThrow(/disabled/);
  });
});
