import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigForTest } from '../../../../src/lib/config';
import {
  loadSkillBody,
  loadSkillFile,
} from '../../../../src/modules/skills/application/skill-content';
import { resetSkillsCache } from '../../../../src/modules/skills/application/skill-discovery';
import { SkillError } from '../../../../src/modules/skills/domain/skill';

let skillsDir: string;
let outsideDir: string;

beforeEach(() => {
  skillsDir = mkdtempSync(join(tmpdir(), 'mango-skill-content-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'mango-skill-outside-'));
  loadConfigForTest({ skills: { dir: skillsDir } });
  resetSkillsCache();

  const dir = join(skillsDir, 'pdf-tools');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: pdf-tools\ndescription: Work with PDF files\n---\n\nRun `scripts/fix.sh`.\n',
    'utf8'
  );
  writeFileSync(join(dir, 'scripts', 'fix.sh'), '#!/bin/sh\necho fixed\n', 'utf8');
  writeFileSync(join(dir, 'reference.md'), 'Reference material.', 'utf8');
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
});

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
  resetSkillsCache();
});

describe('loadSkillBody', () => {
  it('returns the frontmatter-stripped body, base dir, and bundled files', () => {
    const result = loadSkillBody('pdf-tools');

    expect(result.body).toBe('Run `scripts/fix.sh`.');
    expect(result.baseDir).toBe(join(skillsDir, 'pdf-tools'));
    expect(result.files).toEqual(['reference.md', 'scripts/fix.sh']);
    expect(result.filesTruncated).toBe(false);
  });

  it('rejects unknown skills with the valid names listed', () => {
    expect(() => loadSkillBody('nope')).toThrow(SkillError);
    expect(() => loadSkillBody('nope')).toThrow(/Available skills: pdf-tools/);
  });
});

describe('loadSkillFile', () => {
  it('reads a bundled file relative to the skill directory', () => {
    const result = loadSkillFile('pdf-tools', 'scripts/fix.sh');
    expect(result.content).toContain('echo fixed');
    expect(result.truncated).toBe(false);
  });

  it('rejects traversal, absolute paths, and the empty path', () => {
    for (const attempt of ['../outside.txt', '../../etc/passwd', '/etc/passwd', '', '.']) {
      expect(() => loadSkillFile('pdf-tools', attempt)).toThrow(/stay inside the skill directory/);
    }
  });

  it('rejects symlinks that escape the skill directory', () => {
    symlinkSync(join(outsideDir, 'secret.txt'), join(skillsDir, 'pdf-tools', 'escape.txt'));
    expect(() => loadSkillFile('pdf-tools', 'escape.txt')).toThrow(
      /stay inside the skill directory/
    );
  });

  it('returns not-found for missing bundled files', () => {
    expect(() => loadSkillFile('pdf-tools', 'missing.txt')).toThrow(/Skill file not found/);
  });

  it('truncates oversized bundled files and flags it', () => {
    writeFileSync(join(skillsDir, 'pdf-tools', 'big.txt'), 'y'.repeat(256 * 1024 + 10), 'utf8');
    const result = loadSkillFile('pdf-tools', 'big.txt');
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(256 * 1024);
  });
});
