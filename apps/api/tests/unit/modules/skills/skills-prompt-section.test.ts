import { describe, expect, it } from 'bun:test';
import type { SkillDescriptor } from '@mangostudio/shared/skills';
import { buildSkillsPromptSection } from '../../../../src/modules/skills/application/skills-prompt-section';
import { parseSkillKey, skillKey } from '../../../../src/modules/skills/domain/skill';

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
