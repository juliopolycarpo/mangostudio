import { describe, expect, it } from 'bun:test';
import { dirname, win32 } from 'node:path';

import type { ResourceKind } from '@mangostudio/shared/library';
import {
  LibraryLocationStatusSchema,
  LibraryTargetDescriptorSchema,
} from '@mangostudio/shared/library';
import type { LocationFsProbe } from '@mangostudio/shared/library/host';
import {
  assertLibraryRegistryConsistency,
  COMPARABLE_RESOURCE_KINDS,
  DIRECTORY_HASHED_RESOURCE_KINDS,
  getLibraryLocation,
  getLibraryTarget,
  LIBRARY_LOCATION_DEFINITIONS,
  LIBRARY_TARGET_DEFINITIONS,
  listLibraryTargetDescriptors,
  listLibraryTargetLocationIds,
  MANGO_CONFIG_HOME_ENV_KEY,
} from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import Value from 'typebox/value';

import { getConfig, TEST_MANAGED_CONFIG_PATH } from '../../../../src/lib/config';
import {
  createLibraryPathEnv,
  describeLocation,
  describeTargetLocations,
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
    expect([...COMPARABLE_RESOURCE_KINDS].sort()).toEqual([
      'command',
      'instruction',
      'skill',
      'subagent',
    ]);
  });

  it('hashes only directory-of-dirs kinds with the directory domain', () => {
    expect([...DIRECTORY_HASHED_RESOURCE_KINDS]).toEqual(['skill']);
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

  it('reads commands from each vendor home that has one', () => {
    expect(getLibraryTarget('claude')?.reads.command).toEqual(['claude-commands']);
    expect(getLibraryTarget('codex')?.reads.command).toEqual(['codex-prompts']);
    expect(getLibraryTarget('cursor')?.reads.command).toEqual(['cursor-commands']);
  });

  /**
   * Absence here is a decision, not an omission: MangoStudio has no slash
   * commands, so a location for it would report a coverage tick for files
   * nothing loads.
   */
  it('claims no command home for the target that has no commands', () => {
    expect(getLibraryTarget('mangostudio')?.reads.command).toEqual([]);
  });

  it('resolves command locations under each vendor config home, override included', () => {
    expect(getLibraryLocation('claude-commands')?.resolvePath(LINUX_ENV)).toBe(
      '/home/ada/.claude/commands'
    );
    expect(getLibraryLocation('codex-prompts')?.resolvePath(LINUX_ENV)).toBe(
      '/home/ada/.codex/prompts'
    );
    expect(getLibraryLocation('cursor-commands')?.resolvePath(LINUX_ENV)).toBe(
      '/home/ada/.cursor/commands'
    );
    expect(
      getLibraryLocation('codex-prompts')?.resolvePath({
        ...LINUX_ENV,
        env: { CODEX_HOME: '/home/ada/dotfiles/codex' },
      })
    ).toBe('/home/ada/dotfiles/codex/prompts');
  });

  /**
   * A command is one markdown file, so it is hashed as a file. Landing in the
   * directory domain would make every command pair report `incomparable`
   * against a runtime that hashes directories differently.
   *
   * One format across all three is what keeps a propagation a byte copy: a
   * vendor modelled with a different format would need an adapter that does not
   * exist, and every write to it would report `no-adapter-strategy`.
   */
  it('stores commands as flat markdown files in every home', () => {
    for (const id of ['claude-commands', 'codex-prompts', 'cursor-commands'] as const) {
      expect(getLibraryLocation(id)).toMatchObject({
        kind: 'command',
        scope: 'home',
        layout: 'directory-of-files',
        format: 'markdown-frontmatter',
        access: 'read-write',
      });
    }
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

  /**
   * `resolveConfigHome` for `mangostudio` is read by the agent-CLI probe, so it
   * is no longer a registry-only fact the totality test above could not catch
   * drifting. Every `mango-*` location the target reads has to hang off it.
   */
  it('roots every MangoStudio location at the one config home', () => {
    const mango = getLibraryTarget('mangostudio');
    const mangoLocationIds = listLibraryTargetLocationIds('mangostudio').filter((id) =>
      id.startsWith('mango-')
    );
    expect(mangoLocationIds.sort()).toEqual([
      'mango-agents',
      'mango-instructions',
      'mango-settings',
      'mango-skills',
    ]);

    const environments: ReadonlyArray<[string, PathEnv, string]> = [
      ['default home', LINUX_ENV, '/home/ada/.mango'],
      [
        'pinned config home',
        { ...LINUX_ENV, env: { [MANGO_CONFIG_HOME_ENV_KEY]: '/srv/mango' } },
        '/srv/mango',
      ],
      [
        'pinned relative to home',
        { ...LINUX_ENV, env: { [MANGO_CONFIG_HOME_ENV_KEY]: 'dotfiles/mango' } },
        '/home/ada/dotfiles/mango',
      ],
      [
        'windows default',
        { platform: 'win32', homeDir: String.raw`C:\Users\Ada`, env: {} },
        String.raw`C:\Users\Ada\.mango`,
      ],
    ];
    for (const [label, env, expectedHome] of environments) {
      expect(mango?.resolveConfigHome(env), `(${label}): configHome`).toBe(expectedHome);
      const separator = env.platform === 'win32' ? '\\' : '/';
      for (const id of mangoLocationIds) {
        const path = getLibraryLocation(id as never)?.resolvePath(env);
        expect(
          path?.startsWith(`${expectedHome}${separator}`),
          `(${label}): expected ${id} under ${expectedHome} | received ${path}`
        ).toBe(true);
      }
    }
  });

  it('lets SKILLS_DIR and AGENTS_DIR leave the config home on purpose', () => {
    const env: PathEnv = {
      ...LINUX_ENV,
      env: {
        [MANGO_CONFIG_HOME_ENV_KEY]: '/srv/mango',
        SKILLS_DIR: '/data/skills',
        AGENTS_DIR: '/data/agents',
      },
    };

    expect(getLibraryLocation('mango-skills')?.resolvePath(env)).toBe('/data/skills');
    expect(getLibraryLocation('mango-agents')?.resolvePath(env)).toBe('/data/agents');
    expect(getLibraryLocation('mango-settings')?.resolvePath(env)).toBe('/srv/mango/config.toml');
  });

  /**
   * The seam this closes: under the test-managed config the probe reported the
   * test directory as `configHome` while `mango-*` resolved into `~/.mango`.
   */
  it('shares one root between configHome and the mango locations under the managed test config', () => {
    const env = createLibraryPathEnv();
    const configHome = getLibraryTarget('mangostudio')?.resolveConfigHome(env);

    expect(configHome, '(configHome): expected the directory of the loaded config file').toBe(
      dirname(TEST_MANAGED_CONFIG_PATH)
    );
    expect(getConfig().configFilePath).toBe(TEST_MANAGED_CONFIG_PATH);
    for (const id of ['mango-skills', 'mango-agents', 'mango-instructions', 'mango-settings']) {
      const path = getLibraryLocation(id as never)?.resolvePath(env);
      expect(
        path?.startsWith(`${configHome}/`),
        `(${id}): expected a path under ${configHome} | received ${path}`
      ).toBe(true);
    }
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
      scope: 'home',
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
      'claude-commands',
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
