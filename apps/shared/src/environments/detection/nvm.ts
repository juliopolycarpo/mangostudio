import { join } from 'node:path';
import type { PathEnv } from '../../runtime-env';
import type { ManagedVersion, VersionManagerStatus } from '../schemas';
import { type NodeReleaseSchedule, normalizeNodeVersion } from './lts-policy';
import {
  compareVersionStrings,
  createManagedVersionFindings,
  findCurrentVersion,
  listOptionalDirectory,
  type ManagedVersionFileSystem,
  preferNewerVersion,
  readManagedVersions,
  toManagedVersions,
} from './version-manager-support';

export interface NvmFileSystem extends ManagedVersionFileSystem {
  readonly readFile: (path: string) => Promise<string>;
}

export interface NvmDetectionOptions {
  readonly now: Date;
  readonly schedule: NodeReleaseSchedule;
  readonly currentNodePath?: string;
  readonly latestByMajor?: ReadonlyMap<number, string>;
  readonly liveDataAvailable?: boolean;
}

export interface NvmDetectionDeps extends Pick<PathEnv, 'platform' | 'homeDir' | 'env'> {
  readonly fs: NvmFileSystem;
}

interface NvmAliasCache {
  readonly aliases: ReadonlyMap<string, string>;
  /** `lts/*` holds `lts/<codename>` rather than a version, so pointers resolve separately. */
  readonly pointers: ReadonlyMap<string, string>;
  readonly latestByMajor: ReadonlyMap<number, string>;
}

/**
 * The characters an nvm alias name or value may use. Two callers rely on it:
 * the alias cache skips anything else, and the runtime's spawn-env refuses to
 * join a rejected value onto `$NVM_DIR/alias` — so the rule that decides which
 * aliases exist and the rule that decides which are safe to read are one.
 */
export const SAFE_NVM_ALIAS_PATTERN = /^[a-zA-Z0-9_.*/-]+$/;

async function readOptionalFile(fs: NvmFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch {
    return undefined;
  }
}

function parseNvmVersion(nvmScript: string): string | undefined {
  const versionBlock =
    /["']--version["']\s*\|\s*["']-v["'][\s\S]{0,160}?nvm_echo\s+["']([^"']+)["']/.exec(nvmScript);
  return normalizeNodeVersion(versionBlock?.[1] ?? '') ?? undefined;
}

async function resolveNvmRoot(deps: NvmDetectionDeps): Promise<string | undefined> {
  if (deps.platform === 'win32') return undefined;

  const configuredRoot = deps.env.NVM_DIR?.trim();
  const candidates = [configuredRoot, join(deps.homeDir, '.nvm')].filter(
    (candidate, index, roots): candidate is string =>
      Boolean(candidate) && roots.indexOf(candidate) === index
  );

  for (const root of candidates) {
    if (await deps.fs.pathExists(join(root, 'nvm.sh'))) return root;
  }
  return undefined;
}

async function readNvmAliasCache(root: string, fs: NvmFileSystem): Promise<NvmAliasCache> {
  const aliasRoot = join(root, 'alias', 'lts');
  const aliases = new Map<string, string>();
  const pointers = new Map<string, string>();
  const latestByMajor = new Map<number, string>();

  for (const aliasName of await listOptionalDirectory(fs, aliasRoot)) {
    if (!SAFE_NVM_ALIAS_PATTERN.test(aliasName)) continue;
    const value = (await readOptionalFile(fs, join(aliasRoot, aliasName)))?.trim();
    if (!value) continue;
    const version = normalizeNodeVersion(value);
    if (!version) {
      if (SAFE_NVM_ALIAS_PATTERN.test(value))
        pointers.set(aliasName.toLowerCase(), value.toLowerCase());
      continue;
    }
    aliases.set(aliasName.toLowerCase(), version);
    preferNewerVersion(latestByMajor, version);
  }

  return { aliases, pointers, latestByMajor };
}

function readInstalledVersions(
  root: string,
  deps: NvmDetectionDeps
): Promise<Array<{ version: string; path: string }>> {
  const versionsRoot = join(root, 'versions', 'node');
  return readManagedVersions(deps.fs, versionsRoot, (entry) =>
    join(versionsRoot, entry, 'bin', 'node')
  );
}

function highestVersion(versions: readonly { version: string }[]): string | undefined {
  return versions[0]?.version;
}

function resolveDefaultAlias(
  alias: string | undefined,
  aliasCache: NvmAliasCache,
  installedVersions: readonly { version: string }[]
): string | undefined {
  const trimmed = alias?.trim();
  if (!trimmed) return undefined;

  const direct = normalizeNodeVersion(trimmed);
  if (direct) return direct;

  const normalizedAlias = trimmed.toLowerCase();
  if (normalizedAlias === 'node' || normalizedAlias === 'stable') {
    return highestVersion(installedVersions);
  }
  if (normalizedAlias === 'lts/*') {
    // Real nvm writes `lts/<codename>` into `alias/lts/*`, so follow that pointer
    // before falling back to the newest version the alias cache knows about.
    const pointer = aliasCache.pointers.get('*');
    const pointed = pointer?.startsWith('lts/')
      ? aliasCache.aliases.get(pointer.slice('lts/'.length))
      : undefined;
    return (
      aliasCache.aliases.get('*') ??
      pointed ??
      [...aliasCache.latestByMajor.values()].sort(compareVersionStrings).at(-1)
    );
  }
  if (normalizedAlias.startsWith('lts/')) {
    return aliasCache.aliases.get(normalizedAlias.slice('lts/'.length));
  }

  const major = /^v?(\d+)$/.exec(normalizedAlias)?.[1];
  if (major) {
    return installedVersions.find((version) => version.version.startsWith(`${major}.`))?.version;
  }
  return undefined;
}

function mergeLatestVersions(
  aliasCache: NvmAliasCache,
  liveLatestByMajor: ReadonlyMap<number, string> | undefined
): ReadonlyMap<number, string> {
  const latestByMajor = new Map(aliasCache.latestByMajor);
  for (const version of liveLatestByMajor?.values() ?? []) {
    preferNewerVersion(latestByMajor, version);
  }
  return latestByMajor;
}

export async function detectNvm(
  deps: NvmDetectionDeps,
  options: NvmDetectionOptions
): Promise<VersionManagerStatus> {
  const root = await resolveNvmRoot(deps);
  if (!root) {
    return {
      id: 'nvm',
      installed: false,
      versions: [],
      findings: [{ code: 'not-found', params: { manager: 'nvm' } }],
    };
  }

  const [nvmScript, defaultAliasFile, aliasCache, installedVersions] = await Promise.all([
    readOptionalFile(deps.fs, join(root, 'nvm.sh')),
    readOptionalFile(deps.fs, join(root, 'alias', 'default')),
    readNvmAliasCache(root, deps.fs),
    readInstalledVersions(root, deps),
  ]);
  const defaultAlias = defaultAliasFile?.trim() || undefined;
  const defaultVersion = resolveDefaultAlias(defaultAlias, aliasCache, installedVersions);
  const managerVersion = nvmScript ? parseNvmVersion(nvmScript) : undefined;
  const latestByMajor = mergeLatestVersions(aliasCache, options.latestByMajor);
  const currentVersion = findCurrentVersion(
    installedVersions,
    options.currentNodePath,
    deps.platform
  );
  const versions: ManagedVersion[] = toManagedVersions(installedVersions, {
    schedule: options.schedule,
    now: options.now,
    latestByMajor,
    liveDataAvailable: options.liveDataAvailable,
    defaultVersion,
    currentVersion,
  });

  return {
    id: 'nvm',
    installed: true,
    root,
    ...(managerVersion !== undefined && { managerVersion }),
    versions,
    ...(defaultAlias !== undefined && { defaultAlias }),
    ...(defaultVersion !== undefined && { defaultVersion }),
    ...(currentVersion !== undefined && { currentVersion }),
    findings: createManagedVersionFindings(
      'nvm',
      defaultAlias,
      defaultVersion,
      currentVersion,
      versions
    ),
  };
}
