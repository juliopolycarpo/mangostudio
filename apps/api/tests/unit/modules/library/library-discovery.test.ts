import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import { getDb } from '../../../../src/db/database';
import {
  discoverLibraryResources,
  enabledLibraryLocations,
  resetLibraryDiscoveryCache,
} from '../../../../src/modules/library/application/library-discovery';
import { LibraryCache } from '../../../../src/modules/library/infrastructure/library-cache';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mango-library-discovery-'));
  resetLibraryDiscoveryCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetLibraryDiscoveryCache();
});

describe('discoverLibraryResources', () => {
  it('keeps identical slugs in different kinds as distinct resources', async () => {
    const skillsDir = join(root, 'skills');
    const agentsDir = join(root, 'agents');
    mkdirSync(join(skillsDir, 'gh'), { recursive: true });
    mkdirSync(agentsDir);
    writeFileSync(
      join(skillsDir, 'gh', 'SKILL.md'),
      '---\nname: gh\ndescription: GitHub skill\n---\n'
    );
    writeFileSync(join(agentsDir, 'gh.md'), '---\ndescription: GitHub agent\n---\n');

    const resources = await discoverLibraryResources(getDb(), 'library-user', {
      cache: new LibraryCache(),
      settings: {
        ...DEFAULT_APP_SETTINGS,
        libraryLocations: {
          'mango-skills': true,
          'claude-agents': true,
        },
      },
      locationPathOverrides: {
        'mango-skills': skillsDir,
        'claude-agents': agentsDir,
      },
    });

    expect(resources.map(({ key }) => key)).toEqual(['skill:gh', 'subagent:gh']);
  });

  it('always enables mango-skills even when a malformed map disables it', () => {
    expect(enabledLibraryLocations({ 'mango-skills': false })).toContain('mango-skills');
  });

  it('scans directory and single-file layouts across all five resource kinds', async () => {
    const skillsDir = join(root, 'skills');
    const agentsDir = join(root, 'agents');
    const instructionFile = join(root, 'AGENTS.md');
    const settingsFile = join(root, 'config.toml');
    const hooksFile = join(root, 'hooks.json');
    mkdirSync(join(skillsDir, 'review'), { recursive: true });
    mkdirSync(agentsDir);
    writeFileSync(
      join(skillsDir, 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review changes\n---\n'
    );
    writeFileSync(join(agentsDir, 'review.md'), '---\ndescription: Review agent\n---\n');
    writeFileSync(instructionFile, '# Instructions\n');
    writeFileSync(settingsFile, 'theme = "dark"\n');
    writeFileSync(hooksFile, '{"hooks": []}\n');

    const resources = await discoverLibraryResources(getDb(), 'five-kind-user', {
      cache: new LibraryCache(),
      settings: {
        ...DEFAULT_APP_SETTINGS,
        libraryLocations: {
          'mango-skills': true,
          'claude-agents': true,
          'mango-instructions': true,
          'mango-settings': true,
          'codex-hooks': true,
        },
      },
      locationPathOverrides: {
        'mango-skills': skillsDir,
        'claude-agents': agentsDir,
        'mango-instructions': instructionFile,
        'mango-settings': settingsFile,
        'codex-hooks': hooksFile,
      },
    });

    expect(new Set(resources.map(({ ref }) => ref.kind))).toEqual(
      new Set(['skill', 'subagent', 'instruction', 'setting', 'hook'])
    );
  });
});
