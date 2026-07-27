import { describe, expect, it } from 'bun:test';
import { win32 } from 'node:path';
import type { ResourceKind } from '@mangostudio/shared/library';
import {
  LibraryLocationStatusSchema,
  LibraryTargetDescriptorSchema,
} from '@mangostudio/shared/library';
import { Value } from '@sinclair/typebox/value';
import {
  assertLibraryRegistryConsistency,
  COMPARABLE_RESOURCE_KINDS,
  getLibraryLocation,
  getLibraryTarget,
  LIBRARY_LOCATION_DEFINITIONS,
  LIBRARY_TARGET_DEFINITIONS,
  listLibraryTargetDescriptors,
  listLibraryTargetLocationIds,
  type PathEnv,
} from '../../../../src/modules/library/domain/registry';
import {
  describeLocation,
  describeTargetLocations,
  type LocationFsProbe,
} from '../../../../src/modules/library/infrastructure/location-probe';

const LINUX_ENV: PathEnv = {
  platform: 'linux',
  homeDir: '/home/ada',
  env: {},
};

class FakeLocationFs implements LocationFsProbe {
  constructor(
    private readonly existing: ReadonlySet<string>,
    private readonly readable: ReadonlySet<string>,
    private readonly writable: ReadonlySet<string>,
    private readonly counts: ReadonlyMap<string, number> = new Map()
  ) {}

  exists(path: string): boolean {
    return this.existing.has(path);
  }

  isReadable(path: string): boolean {
    return this.readable.has(path);
  }

  isWritable(path: string): boolean {
    return this.writable.has(path);
  }

  countEntries(path: string): number {
    return this.counts.get(path) ?? 0;
  }
}

describe('library target registry', () => {
  it('keeps every target edge total, kind-correct, and bidirectional', () => {
    expect(() => assertLibraryRegistryConsistency()).not.toThrow();

    for (const target of LIBRARY_TARGET_DEFINITIONS) {
      for (const [kind, ids] of Object.entries(target.reads)) {
        for (const id of ids) {
          const location = getLibraryLocation(id);
          expect(location, `${target.id}.${kind} -> ${id}`).toBeDefined();
          expect(location?.kind).toBe(kind as ResourceKind);
          expect(location?.readBy).toContain(target.id);
        }
      }
    }

    for (const location of LIBRARY_LOCATION_DEFINITIONS) {
      for (const targetId of location.readBy) {
        const target = getLibraryTarget(targetId);
        expect(target).toBeDefined();
        expect(target?.reads[location.kind]).toContain(location.id);
      }
    }
  });

  it('gives every single-file location a slug that ignores the vendor filename', () => {
    const slugsById = new Map(
      LIBRARY_LOCATION_DEFINITIONS.filter((location) => location.layout === 'single-file').map(
        (location) => [location.id, location.resourceSlug]
      )
    );

    expect(slugsById.get('claude-instructions')).toBe('global');
    expect(slugsById.get('codex-instructions')).toBe('global');
    expect(slugsById.get('mango-instructions')).toBe('global');
    expect(slugsById.get('mango-settings')).toBe('settings');
    expect(slugsById.get('codex-settings')).toBe('settings');
    expect(slugsById.get('claude-hooks')).toBe('hooks');
    expect([...slugsById.values()].every(Boolean)).toBe(true);
  });

  it('treats only kinds with a writable location as comparable', () => {
    expect([...COMPARABLE_RESOURCE_KINDS].sort()).toEqual(['instruction', 'skill', 'subagent']);
  });

  it('reproduces MangoStudio skill precedence exactly', () => {
    expect(getLibraryTarget('mangostudio')?.reads.skill).toEqual([
      'mango-skills',
      'agents-skills',
      'claude-skills',
    ]);
  });

  it('uses MangoStudio user agents as its native subagent location', () => {
    expect(getLibraryTarget('mangostudio')?.reads.subagent).toEqual(['mango-agents']);
  });

  it('keeps Codex native skills ahead of the shared agents location', () => {
    expect(getLibraryTarget('codex')?.reads.skill).toEqual(['codex-skills', 'agents-skills']);
  });

  it('exposes schema-valid target descriptors with i18n keys', () => {
    const descriptors = listLibraryTargetDescriptors();

    expect(descriptors).toHaveLength(4);
    for (const descriptor of descriptors) {
      expect(Value.Check(LibraryTargetDescriptorSchema, descriptor)).toBe(true);
      expect(descriptor.displayNameKey).toBe(`library.targets.${descriptor.id}`);
    }
  });

  it('honors verified vendor config roots on Windows and macOS', () => {
    const claudeSettings = getLibraryLocation('claude-settings');
    const codexInstructions = getLibraryLocation('codex-instructions');

    expect(
      claudeSettings?.resolvePath({
        platform: 'win32',
        homeDir: String.raw`C:\Users\Ada`,
        env: { CLAUDE_CONFIG_DIR: String.raw`D:\dotfiles\claude` },
      })
    ).toBe(win32.join(String.raw`D:\dotfiles\claude`, 'settings.json'));
    expect(
      codexInstructions?.resolvePath({
        platform: 'darwin',
        homeDir: '/Users/ada',
        env: { CODEX_HOME: '/Volumes/config/codex' },
      })
    ).toBe('/Volumes/config/codex/AGENTS.md');
    expect(
      getLibraryTarget('claude')?.resolveConfigHome({
        platform: 'win32',
        homeDir: String.raw`C:\Users\Ada`,
        env: { CLAUDE_CONFIG_DIR: String.raw`D:\dotfiles\claude` },
      })
    ).toBe(String.raw`D:\dotfiles\claude`);
    expect(
      getLibraryTarget('codex')?.resolveConfigHome({
        platform: 'darwin',
        homeDir: '/Users/ada',
        env: { CODEX_HOME: '/Volumes/config/codex' },
      })
    ).toBe('/Volumes/config/codex');
  });

  it('honors Cursor XDG config without moving unrelated Cursor locations', () => {
    const env = { ...LINUX_ENV, env: { XDG_CONFIG_HOME: '/xdg/config' } };

    expect(getLibraryTarget('cursor')?.resolveConfigHome(env)).toBe('/xdg/config/cursor');
    expect(getLibraryLocation('cursor-settings')?.resolvePath(env)).toBe(
      '/xdg/config/cursor/cli-config.json'
    );
    expect(getLibraryLocation('cursor-skills')?.resolvePath(env)).toBe('/home/ada/.cursor/skills');
  });

  it('reports an unverified platform path as unsupported', () => {
    const fs = new FakeLocationFs(new Set(), new Set(), new Set());
    const status = describeLocation(
      'cursor-skills-builtin',
      { platform: 'darwin', homeDir: '/Users/ada', env: {} },
      fs
    );

    expect(status).toEqual({
      id: 'cursor-skills-builtin',
      kind: 'skill',
      path: null,
      access: 'read-only',
      exists: false,
      readable: false,
      writable: false,
      targetIds: ['cursor'],
    });
    expect(Value.Check(LibraryLocationStatusSchema, status)).toBe(true);
    expect(
      getLibraryLocation('codex-skills')?.resolvePath({
        platform: 'darwin',
        homeDir: '/Users/ada',
        env: {},
      })
    ).toBeNull();
  });

  it('lists every target location once and describes its current health', () => {
    const ids = listLibraryTargetLocationIds('claude');
    const fs = new FakeLocationFs(new Set(), new Set(), new Set(['/home/ada']));

    expect(ids).toEqual([
      'claude-skills',
      'claude-agents',
      'claude-instructions',
      'claude-settings',
      'claude-hooks',
    ]);
    expect(describeTargetLocations('claude', LINUX_ENV, fs).map((status) => status.id)).toEqual(
      ids
    );
  });
});

describe('library location health', () => {
  it('reports a missing destination writable through its nearest existing ancestor', () => {
    const fs = new FakeLocationFs(
      new Set(['/home/ada']),
      new Set(['/home/ada']),
      new Set(['/home/ada'])
    );

    expect(describeLocation('agents-skills', LINUX_ENV, fs)).toMatchObject({
      path: '/home/ada/.agents/skills',
      exists: false,
      readable: false,
      writable: true,
    });
  });

  it('reports readability, writability, and entry count for an existing directory', () => {
    const path = '/home/ada/.claude/skills';
    const fs = new FakeLocationFs(
      new Set([path]),
      new Set([path]),
      new Set([path]),
      new Map([[path, 3]])
    );

    expect(describeLocation('claude-skills', LINUX_ENV, fs)).toMatchObject({
      path,
      exists: true,
      readable: true,
      writable: true,
      entryCount: 3,
      targetIds: ['mangostudio', 'claude'],
    });
  });

  it('resolves Mango skills from the configured skills directory', () => {
    const path = '/srv/mango-skills';
    const fs = new FakeLocationFs(new Set([path]), new Set([path]), new Set([path]));

    expect(
      describeLocation('mango-skills', { ...LINUX_ENV, env: { SKILLS_DIR: path } }, fs).path
    ).toBe(path);
  });

  it('resolves Mango agents from the configured agents directory', () => {
    const path = '/srv/mango-agents';
    const fs = new FakeLocationFs(new Set([path]), new Set([path]), new Set([path]));

    expect(
      describeLocation('mango-agents', { ...LINUX_ENV, env: { AGENTS_DIR: path } }, fs).path
    ).toBe(path);
  });
});
