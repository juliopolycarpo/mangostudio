import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectSkillsDiagnostics,
  type SkillDiagnosticsSource,
} from '../../../../src/modules/skills/application/skill-diagnostics';

let mangoDir: string;
let agentsDir: string;
let claudeDir: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'skill-diag-'));
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

function sources(
  overrides: Partial<Record<'agents' | 'claude', boolean>> = {}
): SkillDiagnosticsSource[] {
  return [
    { source: 'mango', dir: mangoDir, enabled: true },
    { source: 'agents', dir: agentsDir, enabled: overrides.agents ?? false },
    { source: 'claude', dir: claudeDir, enabled: overrides.claude ?? false },
  ];
}

function run(input: { sources: SkillDiagnosticsSource[]; disabledKeys?: ReadonlySet<string> }) {
  return collectSkillsDiagnostics({
    config: { dir: mangoDir, origin: 'default' },
    sources: input.sources,
    disabledKeys: input.disabledKeys ?? new Set(),
  });
}

describe('collectSkillsDiagnostics', () => {
  it('reports source health and counts a valid skill as active', () => {
    writeSkill(mangoDir, 'alpha', 'name: alpha\ndescription: Alpha skill');

    const diag = run({ sources: sources() });

    const mango = diag.sources.find((source) => source.source === 'mango');
    expect(mango).toMatchObject({ health: 'ok', skillCount: 1, enabled: true });
    // agents/claude dirs were never created → missing.
    expect(diag.sources.find((source) => source.source === 'agents')?.health).toBe('missing');
    expect(diag.skills.find((skill) => skill.key === 'mango:alpha')?.state).toBe('active');
  });

  it('flags a frontmatter typo as invalid with the reason', () => {
    writeSkill(mangoDir, 'broken', 'name: wrong-name\ndescription: Mismatched name');

    const diag = run({ sources: sources() });

    const broken = diag.skills.find((skill) => skill.key === 'mango:broken');
    expect(broken?.state).toBe('invalid');
    expect(broken?.error).toContain('name');
  });

  it('marks a lower-precedence copy as shadowed by the winning source', () => {
    writeSkill(mangoDir, 'shared', 'name: shared\ndescription: Mango copy');
    writeSkill(agentsDir, 'shared', 'name: shared\ndescription: Agents copy');

    const diag = run({ sources: sources({ agents: true }) });

    expect(diag.skills.find((skill) => skill.key === 'mango:shared')?.state).toBe('active');
    const shadowed = diag.skills.find((skill) => skill.key === 'agents:shared');
    expect(shadowed?.state).toBe('shadowed');
    expect(shadowed?.shadowedBy).toBe('mango');
  });

  it('reports a disabled skill as disabled', () => {
    writeSkill(mangoDir, 'muted', 'name: muted\ndescription: Turned off');

    const diag = run({ sources: sources(), disabledKeys: new Set(['mango:muted']) });

    expect(diag.skills.find((skill) => skill.key === 'mango:muted')?.state).toBe('disabled');
  });

  it('counts a disabled source but keeps its skills out of the in-play list', () => {
    writeSkill(claudeDir, 'gamma', 'name: gamma\ndescription: Claude skill');

    const diag = run({ sources: sources({ claude: false }) });

    const claude = diag.sources.find((source) => source.source === 'claude');
    expect(claude).toMatchObject({ health: 'ok', skillCount: 1, enabled: false });
    // Source is off, so the skill never appears in the resolved list.
    expect(diag.skills.some((skill) => skill.key === 'claude:gamma')).toBe(false);
  });

  it('marks an unreadable directory as unreadable', () => {
    // A file where a skills directory is expected is a read failure, not ENOENT.
    writeFileSync(mangoDir, 'not a directory', 'utf8');

    const diag = run({ sources: sources() });

    expect(diag.sources.find((source) => source.source === 'mango')?.health).toBe('unreadable');
  });
});
