import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigForTest } from '../../../../src/lib/config';
import {
  listSkills,
  listUsableSkills,
  resetSkillsCache,
} from '../../../../src/modules/skills/application/skill-discovery';

let skillsDir: string;

function writeSkill(slug: string, frontmatter: string, body = 'Do the thing.'): string {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  return dir;
}

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-skills-'));
  loadConfigForTest({ skills: { dir: skillsDir } });
  resetSkillsCache();
});

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  resetSkillsCache();
});

describe('skill discovery', () => {
  it('returns an empty list when the skills directory does not exist', () => {
    loadConfigForTest({ skills: { dir: join(skillsDir, 'missing') } });
    expect(listSkills()).toEqual([]);
  });

  it('discovers valid skills with source-prefixed keys, alphabetically', () => {
    writeSkill('zeta', 'name: zeta\ndescription: Last skill');
    writeSkill('alpha', 'name: alpha\ndescription: First skill');

    const skills = listSkills();
    expect(skills.map((skill) => skill.key)).toEqual(['mango:alpha', 'mango:zeta']);
    expect(skills[0]).toEqual({
      key: 'mango:alpha',
      slug: 'alpha',
      name: 'alpha',
      description: 'First skill',
      source: 'mango',
      path: join(skillsDir, 'alpha'),
      valid: true,
      enabled: true,
    });
  });

  it('ignores flat markdown files and non-directory entries', () => {
    writeFileSync(join(skillsDir, 'loose.md'), '---\nname: loose\n---\nbody', 'utf8');
    expect(listSkills()).toEqual([]);
  });

  it('flags a slug/name mismatch invalid instead of throwing', () => {
    writeSkill('my-skill', 'name: other-name\ndescription: Mismatched');

    const [skill] = listSkills();
    expect(skill?.valid).toBe(false);
    expect(skill?.error).toContain('must match the skill directory name');
    expect(listUsableSkills()).toEqual([]);
  });

  it('accepts numeric-only slugs whose frontmatter the parser coerces to a number', () => {
    writeSkill('2048', 'name: 2048\ndescription: A numeric skill');

    const [skill] = listSkills();
    expect(skill?.valid).toBe(true);
    expect(skill?.name).toBe('2048');
    expect(skill?.description).toBe('A numeric skill');
  });

  it('flags invalid slugs, missing SKILL.md, and missing descriptions', () => {
    mkdirSync(join(skillsDir, 'Bad_Slug'));
    mkdirSync(join(skillsDir, 'empty-dir'));
    writeSkill('no-description', 'name: no-description');

    const errors = new Map(listSkills().map((skill) => [skill.slug, skill.error]));
    expect(errors.get('Bad_Slug')).toContain('not a valid skill slug');
    expect(errors.get('empty-dir')).toContain('SKILL.md not found');
    expect(errors.get('no-description')).toContain('"description" must be a non-empty string');
    expect(listUsableSkills()).toEqual([]);
  });

  it('flags oversized and symlinked SKILL.md files invalid', () => {
    const oversizedDir = join(skillsDir, 'oversized');
    mkdirSync(oversizedDir);
    writeFileSync(join(oversizedDir, 'SKILL.md'), 'x'.repeat(256 * 1024 + 1), 'utf8');

    const target = join(skillsDir, 'target.md');
    writeFileSync(target, '---\nname: linked\ndescription: via symlink\n---\nbody', 'utf8');
    const linkedDir = join(skillsDir, 'linked');
    mkdirSync(linkedDir);
    symlinkSync(target, join(linkedDir, 'SKILL.md'));

    const errors = new Map(listSkills().map((skill) => [skill.slug, skill.error]));
    expect(errors.get('oversized')).toContain('exceeds');
    expect(errors.get('linked')).toContain('not a regular file');
  });

  it('memoizes within the TTL and refreshes after expiry', () => {
    writeSkill('first', 'name: first\ndescription: First skill');

    let clock = 1_000;
    const now = () => clock;
    expect(listSkills(now).map((skill) => skill.slug)).toEqual(['first']);

    writeSkill('second', 'name: second\ndescription: Second skill');
    clock += 1_000;
    expect(listSkills(now).map((skill) => skill.slug)).toEqual(['first']);

    clock += 2_000;
    expect(listSkills(now).map((skill) => skill.slug)).toEqual(['first', 'second']);
  });

  it('rescans immediately when the configured skills dir changes', () => {
    writeSkill('first', 'name: first\ndescription: First skill');
    expect(listSkills().map((skill) => skill.slug)).toEqual(['first']);

    const otherDir = mkdtempSync(join(tmpdir(), 'mango-skills-other-'));
    try {
      loadConfigForTest({ skills: { dir: otherDir } });
      expect(listSkills()).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
