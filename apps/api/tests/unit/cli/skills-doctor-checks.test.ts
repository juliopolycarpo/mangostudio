import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectSkillsDoctorChecks,
  type SkillsDoctorInput,
} from '../../../src/cli/skills-doctor-checks';

let mangoDir: string;
let agentsDir: string;
let claudeDir: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'skills-doctor-'));
  mangoDir = join(root, 'mango');
  agentsDir = join(root, 'agents');
  claudeDir = join(root, 'claude');
});

afterEach(() => {
  rmSync(mangoDir, { recursive: true, force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

function writeSkill(dir: string, slug: string, frontmatter: string): void {
  const skillDir = join(dir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`, 'utf8');
}

function run(overrides: Partial<SkillsDoctorInput> = {}) {
  return collectSkillsDoctorChecks({
    configDir: mangoDir,
    configOrigin: 'default',
    sourceToggles: { agents: false, claude: false },
    disabledKeys: new Set(),
    thirdPartyDirs: { agents: agentsDir, claude: claudeDir },
    ...overrides,
  });
}

function find(results: ReturnType<typeof run>, label: string) {
  const row = results.find((result) => result.label === label);
  if (!row) throw new Error(`missing row: ${label}`);
  return row;
}

describe('collectSkillsDoctorChecks', () => {
  it('renders the config origin and per-source rows', () => {
    writeSkill(mangoDir, 'alpha', 'name: alpha\ndescription: Alpha');

    const results = run({ configOrigin: 'env' });

    expect(find(results, 'Skills config').detail).toContain('(from env)');
    expect(find(results, 'Skills mango').detail).toContain('1 skill(s)');
    // A healthy active skill gets no dedicated row.
    expect(results.some((row) => row.label === 'Skill mango:alpha')).toBe(false);
  });

  it('fails an invalid skill and warns a shadowed one', () => {
    writeSkill(mangoDir, 'broken', 'name: nope\ndescription: bad');
    writeSkill(mangoDir, 'shared', 'name: shared\ndescription: mango');
    writeSkill(agentsDir, 'shared', 'name: shared\ndescription: agents');

    const results = run({ sourceToggles: { agents: true, claude: false } });

    expect(find(results, 'Skill mango:broken').status).toBe('fail');
    const shadowed = find(results, 'Skill agents:shared');
    expect(shadowed.status).toBe('warn');
    expect(shadowed.detail).toContain('shadowed by mango');
  });

  it('marks a disabled skill and notes a disabled source', () => {
    writeSkill(mangoDir, 'muted', 'name: muted\ndescription: off');
    writeSkill(claudeDir, 'gamma', 'name: gamma\ndescription: claude');

    const results = run({ disabledKeys: new Set(['mango:muted']) });

    expect(find(results, 'Skill mango:muted').detail).toContain('disabled in settings');
    expect(find(results, 'Skills claude').detail).toContain('(source disabled)');
  });

  it('fails an unreadable enabled source', () => {
    writeFileSync(mangoDir, 'not a dir', 'utf8');

    const results = run();

    expect(find(results, 'Skills mango').status).toBe('fail');
  });
});
