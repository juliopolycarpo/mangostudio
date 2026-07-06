import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillDescriptor } from '@mangostudio/shared/skills';
import { loadConfigForTest } from '../../../../src/lib/config';
import { resetSkillsCache } from '../../../../src/modules/skills/application/skill-discovery';
import {
  appendSkillsPromptSection,
  buildSkillsPromptSection,
} from '../../../../src/modules/skills/application/skills-prompt-section';
import {
  parseSkillKey,
  SKILL_TOOL_NAME,
  skillKey,
} from '../../../../src/modules/skills/domain/skill';

function makeSkill(overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    key: 'mango:demo',
    slug: 'demo',
    name: 'demo',
    description: 'A demo skill',
    source: 'mango',
    path: '/skills/demo',
    valid: true,
    enabled: true,
    ...overrides,
  };
}

describe('buildSkillsPromptSection', () => {
  it('returns undefined when no usable skills exist', () => {
    expect(buildSkillsPromptSection([])).toBeUndefined();
    expect(buildSkillsPromptSection([makeSkill({ valid: false })])).toBeUndefined();
    expect(buildSkillsPromptSection([makeSkill({ enabled: false })])).toBeUndefined();
  });

  it('lists usable skills alphabetically inside the delimiter block', () => {
    const section = buildSkillsPromptSection([
      makeSkill({ name: 'zeta', description: 'Z skill' }),
      makeSkill({ name: 'alpha', description: 'A skill' }),
      makeSkill({ name: 'broken', valid: false }),
    ]);

    expect(section).toBeDefined();
    expect(section?.startsWith('<available-skills>')).toBe(true);
    expect(section?.endsWith('</available-skills>')).toBe(true);
    expect(section).toContain('call the `skill` tool');
    const alphaIndex = section?.indexOf('- alpha — A skill') ?? -1;
    const zetaIndex = section?.indexOf('- zeta — Z skill') ?? -1;
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(zetaIndex).toBeGreaterThan(alphaIndex);
    expect(section).not.toContain('broken');
  });

  it('caps the listing at 64 skills', () => {
    const skills = Array.from({ length: 65 }, (_, index) =>
      makeSkill({ name: `skill-${String(index).padStart(2, '0')}`, key: `mango:skill-${index}` })
    );
    const section = buildSkillsPromptSection(skills);
    const lines = section?.split('\n').filter((line) => line.startsWith('- ')) ?? [];
    expect(lines).toHaveLength(64);
  });

  it('clamps long descriptions to a single bounded line', () => {
    const section = buildSkillsPromptSection([
      makeSkill({ description: `multi\nline ${'x'.repeat(2_000)}` }),
    ]);
    const line = section?.split('\n').find((candidate) => candidate.startsWith('- demo'));
    expect(line).toBeDefined();
    expect(line?.includes('\n')).toBe(false);
    expect(line?.length).toBeLessThanOrEqual(1_024 + '- demo — '.length);
    expect(line?.endsWith('…')).toBe(true);
    expect(line).toContain('multi line');
  });
});

describe('appendSkillsPromptSection', () => {
  let skillsDir: string | undefined;

  afterEach(() => {
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true });
    skillsDir = undefined;
    resetSkillsCache();
  });

  function installSkill(): void {
    skillsDir = mkdtempSync(join(tmpdir(), 'mango-skills-append-'));
    loadConfigForTest({ skills: { dir: skillsDir } });
    resetSkillsCache();
    const dir = join(skillsDir, 'demo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: A demo\n---\nBody', 'utf8');
  }

  it('appends the section when the skill tool is allowed and skills exist', () => {
    installSkill();
    const result = appendSkillsPromptSection('Base prompt.', new Set([SKILL_TOOL_NAME]));
    expect(result?.startsWith('Base prompt.\n\n<available-skills>')).toBe(true);
    expect(result).toContain('- demo — A demo');
  });

  it('returns the section alone when there is no base prompt', () => {
    installSkill();
    const result = appendSkillsPromptSection(undefined, new Set([SKILL_TOOL_NAME]));
    expect(result?.startsWith('<available-skills>')).toBe(true);
  });

  it('leaves the prompt unchanged when the skill tool is not allowed', () => {
    installSkill();
    expect(appendSkillsPromptSection('Base prompt.', new Set(['read_file']))).toBe('Base prompt.');
  });

  it('leaves the prompt unchanged when no usable skills exist', () => {
    skillsDir = mkdtempSync(join(tmpdir(), 'mango-skills-append-'));
    loadConfigForTest({ skills: { dir: skillsDir } });
    resetSkillsCache();
    expect(appendSkillsPromptSection('Base prompt.', new Set([SKILL_TOOL_NAME]))).toBe(
      'Base prompt.'
    );
    expect(appendSkillsPromptSection(undefined, new Set([SKILL_TOOL_NAME]))).toBeUndefined();
  });
});

describe('skill keys', () => {
  it('round-trips source and slug', () => {
    expect(skillKey('mango', 'pdf-tools')).toBe('mango:pdf-tools');
    expect(parseSkillKey('mango:pdf-tools')).toEqual({ source: 'mango', slug: 'pdf-tools' });
  });

  it('rejects malformed keys', () => {
    expect(parseSkillKey('pdf-tools')).toBeNull();
    expect(parseSkillKey('unknown:pdf-tools')).toBeNull();
    expect(parseSkillKey('mango:Bad_Slug')).toBeNull();
    expect(parseSkillKey(`mango:${'a'.repeat(65)}`)).toBeNull();
  });
});
