import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import {
  loadSkillBody,
  loadSkillFile,
} from '../../../../src/modules/skills/application/skill-content';
import { resetSkillsCache } from '../../../../src/modules/skills/application/skill-discovery';
import { SkillError } from '../../../../src/modules/skills/domain/skill';

const USER_ID = 'skill-content-test-user';
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
  it('returns the frontmatter-stripped body, base dir, and bundled files', async () => {
    const result = await loadSkillBody('pdf-tools', getDb(), USER_ID);

    expect(result.body).toBe('Run `scripts/fix.sh`.');
    expect(result.baseDir).toBe(join(skillsDir, 'pdf-tools'));
    expect(result.files).toEqual(['reference.md', 'scripts/fix.sh']);
    expect(result.filesTruncated).toBe(false);
  });

  it('rejects unknown skills with the valid names listed', async () => {
    await expect(loadSkillBody('nope', getDb(), USER_ID)).rejects.toThrow(SkillError);
    await expect(loadSkillBody('nope', getDb(), USER_ID)).rejects.toThrow(
      /Available skills: pdf-tools/
    );
  });
});

describe('loadSkillFile', () => {
  it('reads a bundled file relative to the skill directory', async () => {
    const result = await loadSkillFile('pdf-tools', 'scripts/fix.sh', getDb(), USER_ID);
    expect(result.content).toContain('echo fixed');
    expect(result.truncated).toBe(false);
  });

  it('rejects traversal, absolute paths, and the empty path', async () => {
    for (const attempt of ['../outside.txt', '../../etc/passwd', '/etc/passwd', '', '.']) {
      await expect(loadSkillFile('pdf-tools', attempt, getDb(), USER_ID)).rejects.toThrow(
        /stay inside the skill directory/
      );
    }
  });

  it('rejects symlinks that escape the skill directory', async () => {
    symlinkSync(join(outsideDir, 'secret.txt'), join(skillsDir, 'pdf-tools', 'escape.txt'));
    await expect(loadSkillFile('pdf-tools', 'escape.txt', getDb(), USER_ID)).rejects.toThrow(
      /stay inside the skill directory/
    );
  });

  it('returns not-found for missing bundled files', async () => {
    await expect(loadSkillFile('pdf-tools', 'missing.txt', getDb(), USER_ID)).rejects.toThrow(
      /Skill file not found/
    );
  });

  it('truncates oversized bundled files and flags it', async () => {
    writeFileSync(join(skillsDir, 'pdf-tools', 'big.txt'), 'y'.repeat(256 * 1024 + 10), 'utf8');
    const result = await loadSkillFile('pdf-tools', 'big.txt', getDb(), USER_ID);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(256 * 1024);
  });
});
