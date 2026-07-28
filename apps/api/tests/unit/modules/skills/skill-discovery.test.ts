import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_LIBRARY_LOCATION_SETTINGS,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { updateAppSettings } from '../../../../src/modules/app-settings/application/app-settings-service';
import {
  listSkills,
  listUsableSkills,
  resetSkillsCache,
  setThirdPartySkillDirsForTest,
} from '../../../../src/modules/skills/application/skill-discovery';
import { upsertSkillSettings } from '../../../../src/modules/skills/infrastructure/skill-settings-repository';

let skillsDir: string;
let agentsDir: string;
let claudeDir: string;
let userCounter = 0;

/** Fresh user per test so settings rows never leak across the shared DB. */
function nextUserId(): string {
  userCounter += 1;
  return `user-skill-discovery-${userCounter}`;
}

async function enableSources(
  userId: string,
  sources: { readonly agents?: boolean; readonly claude?: boolean }
): Promise<void> {
  await updateAppSettings(
    getDb(),
    userId,
    withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
      ...DEFAULT_LIBRARY_LOCATION_SETTINGS,
      home: {
        ...DEFAULT_LIBRARY_LOCATION_SETTINGS.home,
        'agents-skills': sources.agents ?? false,
        'claude-skills': sources.claude ?? false,
      },
    })
  );
}

function writeSkillIn(dir: string, slug: string, frontmatter: string, body = 'Do it.'): string {
  const skillDir = join(dir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  return skillDir;
}

function writeSkill(slug: string, frontmatter: string, body = 'Do the thing.'): string {
  return writeSkillIn(skillsDir, slug, frontmatter, body);
}

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-skills-'));
  agentsDir = mkdtempSync(join(tmpdir(), 'mango-skills-agents-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'mango-skills-claude-'));
  loadConfigForTest({ skills: { dir: skillsDir } });
  setThirdPartySkillDirsForTest({ agents: agentsDir, claude: claudeDir });
  resetSkillsCache();
});

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  setThirdPartySkillDirsForTest(null);
  resetSkillsCache();
});

describe('skill discovery', () => {
  it('returns an empty list when the skills directory does not exist', async () => {
    loadConfigForTest({ skills: { dir: join(skillsDir, 'missing') } });
    expect(await listSkills(getDb(), nextUserId())).toEqual([]);
  });

  it('discovers valid skills with source-prefixed keys, alphabetically', async () => {
    writeSkill('zeta', 'name: zeta\ndescription: Last skill');
    writeSkill('alpha', 'name: alpha\ndescription: First skill');

    const skills = await listSkills(getDb(), nextUserId());
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
    expect(await listSkills(getDb(), nextUserId())).toEqual([]);
  });

  it('flags a slug/name mismatch invalid instead of throwing', async () => {
    writeSkill('my-skill', 'name: other-name\ndescription: Mismatched');

    const userId = nextUserId();
    const [skill] = await listSkills(getDb(), userId);
    expect(skill?.valid).toBe(false);
    expect(skill?.error).toContain('must match the skill directory name');
    expect(await listUsableSkills(getDb(), userId)).toEqual([]);
  });

  it('accepts numeric-only slugs whose frontmatter the parser coerces to a number', async () => {
    writeSkill('2048', 'name: 2048\ndescription: A numeric skill');

    const [skill] = await listSkills(getDb(), nextUserId());
    expect(skill?.valid).toBe(true);
    expect(skill?.name).toBe('2048');
    expect(skill?.description).toBe('A numeric skill');
  });

  it('flags invalid slugs, missing SKILL.md, and missing descriptions', async () => {
    mkdirSync(join(skillsDir, 'Bad_Slug'));
    mkdirSync(join(skillsDir, 'empty-dir'));
    writeSkill('no-description', 'name: no-description');

    const userId = nextUserId();
    const skills = await listSkills(getDb(), userId);
    const errors = new Map(skills.map((skill) => [skill.slug, skill.error]));
    expect(errors.get('Bad_Slug')).toContain('not a valid skill slug');
    expect(errors.get('empty-dir')).toContain('SKILL.md not found');
    expect(errors.get('no-description')).toContain('"description" must be a non-empty string');
    expect(await listUsableSkills(getDb(), userId)).toEqual([]);
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

    const skills = await listSkills(getDb(), nextUserId());
    const errors = new Map(skills.map((skill) => [skill.slug, skill.error]));
    expect(errors.get('oversized')).toContain('exceeds');
    expect(errors.get('linked')).toContain('not a regular file');
  });

  it('memoizes within the TTL and refreshes after expiry', async () => {
    writeSkill('first', 'name: first\ndescription: First skill');

    const userId = nextUserId();
    let clock = 1_000;
    const now = () => clock;
    const slugs = async () => (await listSkills(getDb(), userId, now)).map((skill) => skill.slug);
    expect(await slugs()).toEqual(['first']);

    writeSkill('second', 'name: second\ndescription: Second skill');
    clock += 1_000;
    expect(await slugs()).toEqual(['first']);

    clock += 2_000;
    expect(await slugs()).toEqual(['first', 'second']);
  });

  it('rescans immediately when the configured skills dir changes', async () => {
    writeSkill('first', 'name: first\ndescription: First skill');
    const userId = nextUserId();
    expect((await listSkills(getDb(), userId)).map((skill) => skill.slug)).toEqual(['first']);

    const otherDir = mkdtempSync(join(tmpdir(), 'mango-skills-other-'));
    try {
      loadConfigForTest({ skills: { dir: otherDir } });
      expect(await listSkills(getDb(), userId)).toEqual([]);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe('skill discovery third-party sources', () => {
  it('excludes third-party sources by default', async () => {
    writeSkill('native', 'name: native\ndescription: Native skill');
    writeSkillIn(agentsDir, 'agent-skill', 'name: agent-skill\ndescription: Agents skill');
    writeSkillIn(claudeDir, 'claude-skill', 'name: claude-skill\ndescription: Claude skill');

    const skills = await listSkills(getDb(), nextUserId());
    expect(skills.map((skill) => skill.key)).toEqual(['mango:native']);
  });

  it('includes a third-party source once opted in', async () => {
    writeSkillIn(agentsDir, 'agent-skill', 'name: agent-skill\ndescription: Agents skill');
    writeSkillIn(claudeDir, 'claude-skill', 'name: claude-skill\ndescription: Claude skill');

    const userId = nextUserId();
    await enableSources(userId, { agents: true });

    const skills = await listSkills(getDb(), userId);
    expect(skills.map((skill) => skill.key)).toEqual(['agents:agent-skill']);

    await enableSources(userId, { agents: true, claude: true });
    resetSkillsCache();
    const bothSkills = await listSkills(getDb(), userId);
    expect(bothSkills.map((skill) => skill.key)).toEqual([
      'agents:agent-skill',
      'claude:claude-skill',
    ]);
  });

  it('shadows lower-precedence copies of the same slug (mango > agents > claude)', async () => {
    writeSkill('dup', 'name: dup\ndescription: Mango copy');
    writeSkillIn(agentsDir, 'dup', 'name: dup\ndescription: Agents copy');
    writeSkillIn(claudeDir, 'dup', 'name: dup\ndescription: Claude copy');

    const userId = nextUserId();
    await enableSources(userId, { agents: true, claude: true });

    const skills = await listSkills(getDb(), userId);
    const bySource = new Map(skills.map((skill) => [skill.source, skill]));
    expect(bySource.get('mango')?.shadowed).toBe(false);
    expect(bySource.get('agents')?.shadowed).toBe(true);
    expect(bySource.get('claude')?.shadowed).toBe(true);

    const usable = await listUsableSkills(getDb(), userId);
    expect(usable.map((skill) => skill.key)).toEqual(['mango:dup']);
  });

  it('lets agents win over claude when mango has no copy', async () => {
    writeSkillIn(agentsDir, 'dup', 'name: dup\ndescription: Agents copy');
    writeSkillIn(claudeDir, 'dup', 'name: dup\ndescription: Claude copy');

    const userId = nextUserId();
    await enableSources(userId, { agents: true, claude: true });

    const usable = await listUsableSkills(getDb(), userId);
    expect(usable.map((skill) => skill.key)).toEqual(['agents:dup']);
  });

  it('keeps a disabled winner shadowing lower-precedence copies', async () => {
    writeSkill('dup', 'name: dup\ndescription: Mango copy');
    writeSkillIn(claudeDir, 'dup', 'name: dup\ndescription: Claude copy');

    const userId = nextUserId();
    await enableSources(userId, { claude: true });
    await upsertSkillSettings(getDb(), userId, 'mango:dup', false);

    const skills = await listSkills(getDb(), userId);
    const claudeCopy = skills.find((skill) => skill.key === 'claude:dup');
    expect(claudeCopy?.shadowed).toBe(true);
    expect(await listUsableSkills(getDb(), userId)).toEqual([]);
  });

  it('unshadows a source copy when the winning source is toggled off', async () => {
    writeSkillIn(agentsDir, 'dup', 'name: dup\ndescription: Agents copy');
    writeSkillIn(claudeDir, 'dup', 'name: dup\ndescription: Claude copy');

    const userId = nextUserId();
    await enableSources(userId, { claude: true });

    const usable = await listUsableSkills(getDb(), userId);
    expect(usable.map((skill) => skill.key)).toEqual(['claude:dup']);
  });
});

describe('skill discovery per-skill settings', () => {
  it('excludes a disabled skill from the usable listing but keeps it discovered', async () => {
    writeSkill('togglable', 'name: togglable\ndescription: Can be turned off');

    const userId = nextUserId();
    await upsertSkillSettings(getDb(), userId, 'mango:togglable', false);

    const [skill] = await listSkills(getDb(), userId);
    expect(skill?.enabled).toBe(false);
    expect(await listUsableSkills(getDb(), userId)).toEqual([]);

    await upsertSkillSettings(getDb(), userId, 'mango:togglable', true);
    const usable = await listUsableSkills(getDb(), userId);
    expect(usable.map((skill) => skill.key)).toEqual(['mango:togglable']);
  });

  it('scopes per-skill settings to the owning user', async () => {
    writeSkill('shared', 'name: shared\ndescription: Everyone sees this');

    const owner = nextUserId();
    const other = nextUserId();
    await upsertSkillSettings(getDb(), owner, 'mango:shared', false);

    expect(await listUsableSkills(getDb(), owner)).toEqual([]);
    expect((await listUsableSkills(getDb(), other)).map((skill) => skill.key)).toEqual([
      'mango:shared',
    ]);
  });
});
