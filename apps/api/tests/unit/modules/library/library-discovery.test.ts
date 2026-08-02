import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS, withLibraryLocations } from '@mangostudio/shared/app-settings';
import { enabledLibraryLocations } from '@mangostudio/shared/library';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { getDb } from '../../../../src/db/database';
import {
  discoverLibraryResources,
  resetLibraryDiscoveryCache,
} from '../../../../src/modules/library/application/library-discovery';
import { MAX_LIBRARY_FILE_BYTES } from '../../../../src/modules/library/infrastructure/instance-reader';
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

/** Force-enabled mango-* locations must not scan the developer home. */
function fixturePathEnv() {
  return { platform: process.platform, homeDir: root, env: {} };
}

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
      pathEnv: fixturePathEnv(),
      settings: withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        home: {
          'mango-skills': true,
          'claude-agents': true,
        },
        workspace: {},
      }),
      locationPathOverrides: {
        'mango-skills': skillsDir,
        'claude-agents': agentsDir,
      },
    });

    expect(resources.map(({ key }) => key)).toEqual(['skill:gh', 'subagent:gh']);
  });

  it('always enables MangoStudio native locations even when a malformed map disables them', () => {
    const enabled = enabledLibraryLocations(
      { home: { 'mango-skills': false, 'mango-agents': false }, workspace: {} },
      'home'
    );

    expect(enabled.has('mango-skills')).toBe(true);
    expect(enabled.has('mango-agents')).toBe(true);
  });

  it('does not force MangoStudio native locations on under another scope', () => {
    // Both are directories under the user's home. Forcing them on for a
    // workspace would enable a location that has no definition there.
    const enabled = enabledLibraryLocations(
      { home: { 'mango-skills': true, 'mango-agents': true }, workspace: {} },
      'workspace'
    );

    expect(enabled.size).toBe(0);
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
      pathEnv: fixturePathEnv(),
      settings: withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        home: {
          'mango-skills': true,
          'claude-agents': true,
          'mango-instructions': true,
          'mango-settings': true,
          'codex-hooks': true,
        },
        workspace: {},
      }),
      locationPathOverrides: {
        'mango-skills': skillsDir,
        'claude-agents': agentsDir,
        'mango-instructions': instructionFile,
        'mango-settings': settingsFile,
        'codex-hooks': hooksFile,
      },
    });

    expect(resources.map(({ key }) => key)).toEqual([
      'hook:hooks',
      'instruction:global',
      'setting:settings',
      'skill:review',
      'subagent:review',
    ]);
  });

  it('gives differently named instruction files one cross-target identity', async () => {
    const claudeFile = join(root, 'CLAUDE.md');
    const codexFile = join(root, 'AGENTS.md');
    writeFileSync(claudeFile, '# Shared\n');
    writeFileSync(codexFile, '# Shared\n');

    const [resource, ...rest] = await discoverLibraryResources(getDb(), 'instruction-user', {
      cache: new LibraryCache(),
      pathEnv: fixturePathEnv(),
      settings: withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        home: {
          'claude-instructions': true,
          'codex-instructions': true,
        },
        workspace: {},
      }),
      locationPathOverrides: {
        'claude-instructions': claudeFile,
        'codex-instructions': codexFile,
      },
    });

    expect(rest).toEqual([]);
    expect(resource?.key).toBe('instruction:global');
    expect(resource?.divergence).toBe('uniform');
    expect(resource?.coverage).toEqual(
      expect.arrayContaining(
        [
          { targetId: 'claude', state: 'present', shadowedLocationIds: [] },
          { targetId: 'codex', state: 'present', shadowedLocationIds: [] },
        ].map((coverage) => expect.objectContaining(coverage))
      )
    );
  });

  it('reports a settings file that exceeds the instance byte budget as too large', async () => {
    const settingsFile = join(root, 'config.toml');
    writeFileSync(settingsFile, `note = "${'x'.repeat(MAX_LIBRARY_FILE_BYTES)}"\n`);

    const [resource] = await discoverLibraryResources(getDb(), 'oversized-user', {
      cache: new LibraryCache(),
      pathEnv: fixturePathEnv(),
      settings: withLibraryLocations(DEFAULT_APP_SETTINGS, DEFAULT_PROFILE_ID, {
        home: {
          'mango-settings': true,
        },
        workspace: {},
      }),
      locationPathOverrides: { 'mango-settings': settingsFile },
    });

    const [instance] = resource?.instances ?? [];
    expect(instance?.valid).toBe(false);
    expect(instance?.valid === false && instance.invalidReason).toBe('too-large');
    expect(instance?.contentHash).toBeUndefined();
  });
});
