import { posix, win32 } from 'node:path';
import type {
  LibraryLocationId,
  LibraryTargetDescriptor,
  LibraryTargetId,
  LocationAccess,
  ResourceFormat,
  ResourceKind,
} from '@mangostudio/shared/library';
import type { PathEnv } from '../../../lib/path-env';

export type LibraryLocationLayout = 'directory-of-dirs' | 'directory-of-files' | 'single-file';

export type { PathEnv } from '../../../lib/path-env';

export interface LocationDefinition {
  readonly id: LibraryLocationId;
  readonly kind: ResourceKind;
  /** Resolved per call so config and environment changes cannot go stale. */
  readonly resolvePath: (env: PathEnv) => string | null;
  readonly access: LocationAccess;
  readonly layout: LibraryLocationLayout;
  readonly format: ResourceFormat;
  /** Every target that reads this location. */
  readonly readBy: readonly LibraryTargetId[];
}

export interface TargetDefinition {
  readonly id: LibraryTargetId;
  readonly displayNameKey: `library.targets.${LibraryTargetId}`;
  /** Canonical home for target-level config and authentication signals. */
  readonly resolveConfigHome: (env: PathEnv) => string;
  /** Per kind, highest-precedence location first. */
  readonly reads: Readonly<Record<ResourceKind, readonly LibraryLocationId[]>>;
}

function pathApi(env: PathEnv): typeof posix | typeof win32 {
  return env.platform === 'win32' ? win32 : posix;
}

function supportsHomeLocations(env: PathEnv): boolean {
  return env.platform === 'linux' || env.platform === 'darwin' || env.platform === 'win32';
}

function resolveEnvPath(env: PathEnv, value: string): string {
  const api = pathApi(env);
  return api.isAbsolute(value) ? api.normalize(value) : api.resolve(env.homeDir, value);
}

function configuredDir(env: PathEnv, variable: string, fallbackParts: readonly string[]): string {
  const configured = env.env[variable]?.trim();
  return configured
    ? resolveEnvPath(env, configured)
    : pathApi(env).join(env.homeDir, ...fallbackParts);
}

function homePath(...parts: string[]): (env: PathEnv) => string | null {
  return (env) => (supportsHomeLocations(env) ? pathApi(env).join(env.homeDir, ...parts) : null);
}

function mangoSkillsPath(env: PathEnv): string | null {
  if (!supportsHomeLocations(env)) return null;
  return configuredDir(env, 'SKILLS_DIR', ['.mango', 'skills']);
}

function mangoConfigHome(env: PathEnv): string {
  return pathApi(env).join(env.homeDir, '.mango');
}

function claudeConfigHome(env: PathEnv): string {
  return configuredDir(env, 'CLAUDE_CONFIG_DIR', ['.claude']);
}

function claudePath(...parts: string[]): (env: PathEnv) => string | null {
  return (env) => {
    if (!supportsHomeLocations(env)) return null;
    return pathApi(env).join(claudeConfigHome(env), ...parts);
  };
}

function codexConfigHome(env: PathEnv): string {
  return configuredDir(env, 'CODEX_HOME', ['.codex']);
}

function codexPath(...parts: string[]): (env: PathEnv) => string | null {
  return (env) => {
    if (!supportsHomeLocations(env)) return null;
    return pathApi(env).join(codexConfigHome(env), ...parts);
  };
}

function codexLinuxOnlyPath(...parts: string[]): (env: PathEnv) => string | null {
  const resolveCodexPath = codexPath(...parts);
  return (env) => (env.platform === 'linux' ? resolveCodexPath(env) : null);
}

function cursorConfigHome(env: PathEnv): string {
  const configured = env.env.CURSOR_CONFIG_DIR?.trim();
  if (configured) {
    return resolveEnvPath(env, configured);
  }

  const xdgConfigHome = env.platform === 'linux' ? env.env.XDG_CONFIG_HOME?.trim() : undefined;
  if (xdgConfigHome) {
    return posix.join(resolveEnvPath(env, xdgConfigHome), 'cursor');
  }

  return pathApi(env).join(env.homeDir, '.cursor');
}

function cursorSettingsPath(env: PathEnv): string | null {
  if (!supportsHomeLocations(env)) return null;
  return pathApi(env).join(cursorConfigHome(env), 'cli-config.json');
}

function cursorLinuxOnlyPath(...parts: string[]): (env: PathEnv) => string | null {
  return (env) => {
    if (env.platform !== 'linux') return null;
    return posix.join(env.homeDir, '.cursor', ...parts);
  };
}

export const LIBRARY_LOCATION_DEFINITIONS: readonly LocationDefinition[] = [
  {
    id: 'mango-skills',
    kind: 'skill',
    resolvePath: mangoSkillsPath,
    access: 'read-write',
    layout: 'directory-of-dirs',
    format: 'markdown-frontmatter',
    readBy: ['mangostudio'],
  },
  {
    id: 'agents-skills',
    kind: 'skill',
    resolvePath: homePath('.agents', 'skills'),
    access: 'read-write',
    layout: 'directory-of-dirs',
    format: 'markdown-frontmatter',
    readBy: ['mangostudio', 'codex'],
  },
  {
    id: 'claude-skills',
    kind: 'skill',
    resolvePath: claudePath('skills'),
    access: 'read-write',
    layout: 'directory-of-dirs',
    format: 'markdown-frontmatter',
    readBy: ['mangostudio', 'claude'],
  },
  {
    id: 'codex-skills',
    kind: 'skill',
    // TODO(verify:darwin): Codex documents ~/.agents/skills, not this internal root.
    // TODO(verify:win32): Codex documents ~/.agents/skills, not this internal root.
    resolvePath: codexLinuxOnlyPath('skills'),
    access: 'read-write',
    layout: 'directory-of-dirs',
    format: 'markdown-frontmatter',
    readBy: ['codex'],
  },
  {
    id: 'cursor-skills',
    kind: 'skill',
    resolvePath: homePath('.cursor', 'skills'),
    access: 'read-write',
    layout: 'directory-of-dirs',
    format: 'markdown-frontmatter',
    readBy: ['cursor'],
  },
  {
    id: 'cursor-skills-builtin',
    kind: 'skill',
    // TODO(verify:darwin): Cursor documents built-ins but not their on-disk path.
    // TODO(verify:win32): Cursor documents built-ins but not their on-disk path.
    resolvePath: cursorLinuxOnlyPath('skills-cursor'),
    access: 'read-only',
    layout: 'directory-of-dirs',
    format: 'markdown-frontmatter',
    readBy: ['cursor'],
  },
  {
    id: 'claude-agents',
    kind: 'subagent',
    resolvePath: claudePath('agents'),
    access: 'read-write',
    layout: 'directory-of-files',
    format: 'markdown-frontmatter',
    readBy: ['claude'],
  },
  {
    id: 'codex-agents',
    kind: 'subagent',
    resolvePath: codexPath('agents'),
    access: 'read-write',
    layout: 'directory-of-files',
    format: 'toml-agent',
    readBy: ['codex'],
  },
  {
    id: 'cursor-agents',
    kind: 'subagent',
    resolvePath: homePath('.cursor', 'agents'),
    access: 'read-write',
    layout: 'directory-of-files',
    format: 'markdown-frontmatter',
    readBy: ['cursor'],
  },
  {
    id: 'mango-instructions',
    kind: 'instruction',
    resolvePath: homePath('.mango', 'AGENTS.md'),
    access: 'read-write',
    layout: 'single-file',
    format: 'markdown-plain',
    readBy: ['mangostudio'],
  },
  {
    id: 'claude-instructions',
    kind: 'instruction',
    resolvePath: claudePath('CLAUDE.md'),
    access: 'read-write',
    layout: 'single-file',
    format: 'markdown-plain',
    readBy: ['claude'],
  },
  {
    id: 'codex-instructions',
    kind: 'instruction',
    resolvePath: codexPath('AGENTS.md'),
    access: 'read-write',
    layout: 'single-file',
    format: 'markdown-plain',
    readBy: ['codex'],
  },
  {
    id: 'cursor-rules',
    kind: 'instruction',
    // TODO(verify:darwin): Cursor only documents project rule paths cross-platform.
    // TODO(verify:win32): Cursor only documents project rule paths cross-platform.
    resolvePath: cursorLinuxOnlyPath('rules'),
    access: 'read-write',
    layout: 'directory-of-files',
    format: 'mdc',
    readBy: ['cursor'],
  },
  {
    id: 'claude-settings',
    kind: 'setting',
    resolvePath: claudePath('settings.json'),
    access: 'read-only',
    layout: 'single-file',
    format: 'json-settings',
    readBy: ['claude'],
  },
  {
    id: 'codex-settings',
    kind: 'setting',
    resolvePath: codexPath('config.toml'),
    access: 'read-only',
    layout: 'single-file',
    format: 'toml-settings',
    readBy: ['codex'],
  },
  {
    id: 'cursor-settings',
    kind: 'setting',
    resolvePath: cursorSettingsPath,
    access: 'read-only',
    layout: 'single-file',
    format: 'json-settings',
    readBy: ['cursor'],
  },
  {
    id: 'mango-settings',
    kind: 'setting',
    resolvePath: homePath('.mango', 'config.toml'),
    access: 'read-only',
    layout: 'single-file',
    format: 'toml-settings',
    readBy: ['mangostudio'],
  },
  {
    id: 'codex-hooks',
    kind: 'hook',
    resolvePath: codexPath('hooks.json'),
    access: 'read-only',
    layout: 'single-file',
    format: 'json-settings',
    readBy: ['codex'],
  },
  {
    id: 'claude-hooks',
    kind: 'hook',
    resolvePath: claudePath('settings.json'),
    access: 'read-only',
    layout: 'single-file',
    format: 'json-settings',
    readBy: ['claude'],
  },
  {
    id: 'codex-permission-rules',
    kind: 'hook',
    resolvePath: codexPath('rules'),
    access: 'read-only',
    layout: 'directory-of-files',
    format: 'rules-dsl',
    readBy: ['codex'],
  },
];

export const LIBRARY_TARGET_DEFINITIONS: readonly TargetDefinition[] = [
  {
    id: 'mangostudio',
    displayNameKey: 'library.targets.mangostudio',
    resolveConfigHome: mangoConfigHome,
    reads: {
      skill: ['mango-skills', 'agents-skills', 'claude-skills'],
      subagent: [],
      instruction: ['mango-instructions'],
      setting: ['mango-settings'],
      hook: [],
    },
  },
  {
    id: 'claude',
    displayNameKey: 'library.targets.claude',
    resolveConfigHome: claudeConfigHome,
    reads: {
      skill: ['claude-skills'],
      subagent: ['claude-agents'],
      instruction: ['claude-instructions'],
      setting: ['claude-settings'],
      hook: ['claude-hooks'],
    },
  },
  {
    id: 'codex',
    displayNameKey: 'library.targets.codex',
    resolveConfigHome: codexConfigHome,
    reads: {
      skill: ['codex-skills', 'agents-skills'],
      subagent: ['codex-agents'],
      instruction: ['codex-instructions'],
      setting: ['codex-settings'],
      hook: ['codex-hooks', 'codex-permission-rules'],
    },
  },
  {
    id: 'cursor',
    displayNameKey: 'library.targets.cursor',
    resolveConfigHome: cursorConfigHome,
    reads: {
      skill: ['cursor-skills', 'cursor-skills-builtin'],
      subagent: ['cursor-agents'],
      instruction: ['cursor-rules'],
      setting: ['cursor-settings'],
      hook: [],
    },
  },
];

const locationById = new Map(
  LIBRARY_LOCATION_DEFINITIONS.map((location) => [location.id, location] as const)
);
const targetById = new Map(
  LIBRARY_TARGET_DEFINITIONS.map((target) => [target.id, target] as const)
);

export function getLibraryLocation(id: LibraryLocationId): LocationDefinition | undefined {
  return locationById.get(id);
}

export function getLibraryTarget(id: LibraryTargetId): TargetDefinition | undefined {
  return targetById.get(id);
}

export function listLibraryTargetLocationIds(id: LibraryTargetId): LibraryLocationId[] {
  const target = getLibraryTarget(id);
  if (!target) return [];
  return [...new Set(Object.values(target.reads).flat())];
}

export function listLibraryTargetDescriptors(): LibraryTargetDescriptor[] {
  return LIBRARY_TARGET_DEFINITIONS.map((target) => ({
    id: target.id,
    displayNameKey: target.displayNameKey,
    reads: {
      skill: [...target.reads.skill],
      subagent: [...target.reads.subagent],
      instruction: [...target.reads.instruction],
      setting: [...target.reads.setting],
      hook: [...target.reads.hook],
    },
  }));
}

/** Fails fast if a code-defined id, kind, or reverse target edge drifts. */
export function assertLibraryRegistryConsistency(): void {
  if (locationById.size !== LIBRARY_LOCATION_DEFINITIONS.length) {
    throw new Error('Library registry contains duplicate location ids.');
  }
  if (targetById.size !== LIBRARY_TARGET_DEFINITIONS.length) {
    throw new Error('Library registry contains duplicate target ids.');
  }

  for (const target of LIBRARY_TARGET_DEFINITIONS) {
    for (const [kind, ids] of Object.entries(target.reads) as [
      ResourceKind,
      readonly LibraryLocationId[],
    ][]) {
      for (const id of ids) {
        const location = locationById.get(id);
        if (!location) {
          throw new Error(`Target "${target.id}" references unknown location "${id}".`);
        }
        if (location.kind !== kind) {
          throw new Error(
            `Target "${target.id}" reads "${id}" as ${kind}, but the location kind is ${location.kind}.`
          );
        }
        if (!location.readBy.includes(target.id)) {
          throw new Error(`Location "${id}" is missing reverse edge to target "${target.id}".`);
        }
      }
    }
  }

  for (const location of LIBRARY_LOCATION_DEFINITIONS) {
    for (const targetId of location.readBy) {
      const target = targetById.get(targetId);
      if (!target) {
        throw new Error(`Location "${location.id}" references unknown target "${targetId}".`);
      }
      if (!target.reads[location.kind].includes(location.id)) {
        throw new Error(
          `Target "${targetId}" is missing reverse edge to location "${location.id}".`
        );
      }
    }
  }
}

assertLibraryRegistryConsistency();
