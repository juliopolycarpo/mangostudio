import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { upsertAppSettings } from '../../../../src/modules/app-settings/infrastructure/app-settings-repository';
import {
  listSkills,
  listUsableSkills,
  resetSkillsCache,
} from '../../../../src/modules/skills/application/skill-discovery';
import { upsertSkillSettings } from '../../../../src/modules/skills/infrastructure/skill-settings-repository';

const USER_ID = 'skill-discovery-test-user';
const ORIGINAL_HOME = homedir();

async function setSkillSources(sources: { agents: boolean; claude: boolean }): Promise<void> {
  await upsertAppSettings(getDb(), USER_ID, {
    ...DEFAULT_APP_SETTINGS,
    skillSources: sources,
  });
}

function setHome(dir: string): void {
  process.env.HOME = dir;
}

function restoreHome(): void {
  process.env.HOME = ORIGINAL_HOME;
}

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
  it('returns an empty list when the skills directory does not exist', async () => {
    loadConfigForTest({ skills: { dir: join(skillsDir, 'missing') } });
    const { skills } = await listSkills(getDb(), USER_ID);
    expect(skills).toEqual([]);
  });

  it('discovers valid skills with source-prefixed keys, alphabetically', async () => {
    writeSkill('zeta', 'name: zeta\ndescription: Last skill');
    writeSkill('alpha', 'name: alpha\ndescription: First skill');

    const { skills } = await listSkills(getDb(), USER_ID);
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
      shadowed: false,
    });
  });

  it('ignores flat markdown files and non-directory entries', async () => {
    writeFileSync(join(skillsDir, 'loose.md'), '---\nname: loose\n---\nbody', 'utf8');
    const { skills } = await listSkills(getDb(), USER_ID);
    expect(skills).toEqual([]);
  });

  it('flags a slug/name mismatch invalid instead of throwing', async () => {
    writeSkill('my-skill', 'name: other-name\ndescription: Mismatched');

    const { skills } = await listSkills(getDb(), USER_ID);
    expect(skills[0]?.valid).toBe(false);
    expect(skills[0]?.error).toContain('must match the skill directory name');
    expect(await listUsableSkills(getDb(), USER_ID)).toEqual([]);
  });

  it('accepts numeric-only slugs whose frontmatter the parser coerces to a number', async () => {
    writeSkill('2048', 'name: 2048\ndescription: A numeric skill');

    const { skills } = await listSkills(getDb(), USER_ID);
    expect(skills[0]?.valid).toBe(true);
    expect(skills[0]?.name).toBe('2048');
    expect(skills[0]?.description).toBe('A numeric skill');
  });

  it('flags invalid slugs, missing SKILL.md, and missing descriptions', async () => {
    mkdirSync(join(skillsDir, 'Bad_Slug'));
    mkdirSync(join(skillsDir, 'empty-dir'));
    writeSkill('no-description', 'name: no-description');

    const { skills } = await listSkills(getDb(), USER_ID);
    const errors = new Map(skills.map((skill) => [skill.slug, skill.error]));
    expect(errors.get('Bad_Slug')).toContain('not a valid skill slug');
    expect(errors.get('empty-dir')).toContain('SKILL.md not found');
    expect(errors.get('no-description')).toContain('"description" must be a non-empty string');
    expect(await listUsableSkills(getDb(), USER_ID)).toEqual([]);
  });

  it('flags oversized and symlinked SKILL.md files invalid', async () => {
    const oversizedDir = join(skillsDir, 'oversized');
    mkdirSync(oversizedDir);
    writeFileSync(join(oversizedDir, 'SKILL.md'), 'x'.repeat(256 * 1024 + 1), 'utf8');

    const target = join(skillsDir, 'target.md');
    writeFileSync(target, '---\nname: linked\ndescription: via symlink\n---\nbody', 'utf8');
    const linkedDir = join(skillsDir, 'linked');
    mkdirSync(linkedDir);
    symlinkSync(target, join(linkedDir, 'SKILL.md'));

    const { skills } = await listSkills(getDb(), USER_ID);
    const errors = new Map(skills.map((skill) => [skill.slug, skill.error]));
    expect(errors.get('oversized')).toContain('exceeds');
    expect(errors.get('linked')).toContain('not a regular file');
  });

  it('memoizes within the TTL and refreshes after expiry', async () => {
    writeSkill('first', 'name: first\ndescription: First skill');

    let clock = 1_000;
    const now = () => clock;
    const { skills: first } = await listSkills(getDb(), USER_ID, now);
    expect(first.map((skill) => skill.slug)).toEqual(['first']);

    writeSkill('second', 'name: second\ndescription: Second skill');
    clock += 1_000;
    const { skills: cached } = await listSkills(getDb(), USER_ID, now);
    expect(cached.map((skill) => skill.slug)).toEqual(['first']);

    clock += 2_000;
    const { skills: refreshed } = await listSkills(getDb(), USER_ID, now);
    expect(refreshed.map((skill) => skill.slug)).toEqual(['first', 'second']);
  });

  it('rescans immediately when the configured skills dir changes', async () => {
    writeSkill('first', 'name: first\ndescription: First skill');
    const { skills } = await listSkills(getDb(), USER_ID);
    expect(skills.map((skill) => skill.slug)).toEqual(['first']);

    const otherDir = mkdtempSync(join(tmpdir(), 'mango-skills-other-'));
    try {
      loadConfigForTest({ skills: { dir: otherDir } });
      const { skills: empty } = await listSkills(getDb(), USER_ID);
      expect(empty).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe('skill source toggles and shadowing', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'mango-skills-home-'));
    setHome(homeDir);
    mkdirSync(join(homeDir, '.agents', 'skills'), { recursive: true });
    mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true });
    resetSkillsCache();
  });

  afterEach(() => {
    restoreHome();
    rmSync(homeDir, { recursive: true, force: true });
    resetSkillsCache();
  });

  function writeSkillIn(source: 'agents' | 'claude', slug: string, description: string): string {
    const baseDir =
      source === 'agents' ? join(homeDir, '.agents', 'skills') : join(homeDir, '.claude', 'skills');
    const dir = join(baseDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: ${description}\n---\nbody`,
      'utf8'
    );
    return dir;
  }

  it('omits third-party skills when their source toggle is off', async () => {
    writeSkillIn('agents', 'agent-skill', 'From agents');
    writeSkillIn('claude', 'claude-skill', 'From claude');
    await setSkillSources({ agents: false, claude: false });

    const { skills, sources } = await listSkills(getDb(), USER_ID);
    expect(skills.map((skill) => skill.source)).not.toContain('agents');
    expect(skills.map((skill) => skill.source)).not.toContain('claude');
    expect(sources.agents.enabled).toBe(false);
    expect(sources.claude.enabled).toBe(false);
  });

  it('includes third-party skills when their source toggle is on', async () => {
    writeSkillIn('agents', 'agent-skill', 'From agents');
    await setSkillSources({ agents: true, claude: false });

    const { skills, sources } = await listSkills(getDb(), USER_ID);
    const agent = skills.find((skill) => skill.key === 'agents:agent-skill');
    expect(agent).toBeDefined();
    expect(agent?.valid).toBe(true);
    expect(sources.agents.enabled).toBe(true);
    expect(sources.agents.exists).toBe(true);
  });

  it('shadows lower-precedence copies of the same slug (mango > agents > claude)', async () => {
    writeSkill('shared', 'name: shared\ndescription: Mango copy');
    writeSkillIn('agents', 'shared', 'Agents copy');
    writeSkillIn('claude', 'shared', 'Claude copy');
    await setSkillSources({ agents: true, claude: true });

    const { skills } = await listSkills(getDb(), USER_ID);
    const byKey = new Map(skills.map((skill) => [skill.key, skill]));
    expect(byKey.get('mango:shared')?.shadowed).toBe(false);
    expect(byKey.get('agents:shared')?.shadowed).toBe(true);
    expect(byKey.get('claude:shared')?.shadowed).toBe(true);

    const usable = await listUsableSkills(getDb(), USER_ID);
    expect(usable.map((skill) => skill.key)).toEqual(['mango:shared']);
  });

  it('agents shadows claude when mango is absent', async () => {
    writeSkillIn('agents', 'shared', 'Agents copy');
    writeSkillIn('claude', 'shared', 'Claude copy');
    await setSkillSources({ agents: true, claude: true });

    const { skills } = await listSkills(getDb(), USER_ID);
    const byKey = new Map(skills.map((skill) => [skill.key, skill]));
    expect(byKey.get('agents:shared')?.shadowed).toBe(false);
    expect(byKey.get('claude:shared')?.shadowed).toBe(true);
  });

  it('disabled winner still shadows losers (predictable precedence)', async () => {
    writeSkill('shared', 'name: shared\ndescription: Mango copy');
    writeSkillIn('agents', 'shared', 'Agents copy');
    await setSkillSources({ agents: true, claude: false });

    const db = getDb();
    await upsertSkillSettings(db, USER_ID, 'mango:shared', false);

    const { skills } = await listSkills(db, USER_ID);
    const byKey = new Map(skills.map((skill) => [skill.key, skill]));
    expect(byKey.get('mango:shared')?.enabled).toBe(false);
    expect(byKey.get('mango:shared')?.shadowed).toBe(false);
    expect(byKey.get('agents:shared')?.shadowed).toBe(true);

    // The disabled winner is not usable, but the shadowed loser does NOT take over.
    const usable = await listUsableSkills(db, USER_ID);
    expect(usable).toEqual([]);
  });

  it('per-skill toggle excludes a skill from the usable list', async () => {
    writeSkill('alpha', 'name: alpha\ndescription: Alpha skill');
    writeSkill('beta', 'name: beta\ndescription: Beta skill');

    const db = getDb();
    await upsertSkillSettings(db, USER_ID, 'mango:alpha', false);

    const usable = await listUsableSkills(db, USER_ID);
    expect(usable.map((skill) => skill.slug)).toEqual(['beta']);
  });

  it('surfaces source path and existence for the fixed third-party dirs', async () => {
    await setSkillSources({ agents: true, claude: true });
    const { sources } = await listSkills(getDb(), USER_ID);
    expect(sources.agents.path).toBe(join(homeDir, '.agents', 'skills'));
    expect(sources.claude.path).toBe(join(homeDir, '.claude', 'skills'));
    expect(sources.agents.exists).toBe(true);
    expect(sources.claude.exists).toBe(true);
  });

  it('reports exists=false when a third-party directory is missing', async () => {
    rmSync(join(homeDir, '.claude', 'skills'), { recursive: true, force: true });
    await setSkillSources({ agents: true, claude: true });
    const { sources } = await listSkills(getDb(), USER_ID);
    expect(sources.claude.exists).toBe(false);
  });
});
