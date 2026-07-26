import { existsSync } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ManagedVersion,
  RuntimeFinding,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import type { PathEnv } from '../../../lib/path-env';
import {
  classifyNodeLtsStatus,
  findNodeReleaseLine,
  type NodeReleaseSchedule,
  normalizeNodeVersion,
  parseNodeVersion,
} from './lts-policy';

export interface NvmFileSystem {
  readonly pathExists: (path: string) => boolean | Promise<boolean>;
  readonly readFile: (path: string) => Promise<string>;
  readonly readDirectory: (path: string) => Promise<readonly string[]>;
  readonly realpath: (path: string) => Promise<string>;
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

const VERSION_DIRECTORY_PATTERN = /^v?(\d+\.\d+\.\d+)$/;
const SAFE_ALIAS_PATTERN = /^[a-zA-Z0-9_.*/-]+$/;

export function createNvmFileSystem(): NvmFileSystem {
  return {
    pathExists: existsSync,
    readFile: (path) => readFile(path, 'utf8'),
    readDirectory: async (path) => {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => entry.name);
    },
    realpath,
  };
}

async function readOptionalFile(fs: NvmFileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path);
  } catch {
    return undefined;
  }
}

async function listOptionalDirectory(fs: NvmFileSystem, path: string): Promise<readonly string[]> {
  try {
    return await fs.readDirectory(path);
  } catch {
    return [];
  }
}

function normalizedPath(path: string, platform: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function compareVersionStrings(left: string, right: string): number {
  const leftVersion = parseNodeVersion(left);
  const rightVersion = parseNodeVersion(right);
  if (!leftVersion || !rightVersion) return left.localeCompare(right);
  if (leftVersion.major !== rightVersion.major) return leftVersion.major - rightVersion.major;
  if (leftVersion.minor !== rightVersion.minor) return leftVersion.minor - rightVersion.minor;
  return leftVersion.patch - rightVersion.patch;
}

function preferNewerVersion(latestByMajor: Map<number, string>, versionValue: string): void {
  const version = parseNodeVersion(versionValue);
  if (!version) return;
  const existing = latestByMajor.get(version.major);
  if (!existing || compareVersionStrings(versionValue, existing) > 0) {
    latestByMajor.set(version.major, versionValue);
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
    if (!SAFE_ALIAS_PATTERN.test(aliasName)) continue;
    const value = (await readOptionalFile(fs, join(aliasRoot, aliasName)))?.trim();
    if (!value) continue;
    const version = normalizeNodeVersion(value);
    if (!version) {
      if (SAFE_ALIAS_PATTERN.test(value))
        pointers.set(aliasName.toLowerCase(), value.toLowerCase());
      continue;
    }
    aliases.set(aliasName.toLowerCase(), version);
    preferNewerVersion(latestByMajor, version);
  }

  return { aliases, pointers, latestByMajor };
}

async function readInstalledVersions(
  root: string,
  deps: NvmDetectionDeps
): Promise<Array<{ version: string; path: string }>> {
  const versionsRoot = join(root, 'versions', 'node');
  const versions: Array<{ version: string; path: string }> = [];

  for (const entry of await listOptionalDirectory(deps.fs, versionsRoot)) {
    const match = VERSION_DIRECTORY_PATTERN.exec(entry);
    if (!match) continue;
    const nodePath = join(versionsRoot, entry, 'bin', 'node');
    if (!(await deps.fs.pathExists(nodePath))) continue;

    let resolvedPath = nodePath;
    try {
      resolvedPath = await deps.fs.realpath(nodePath);
    } catch {
      // The binary exists, so retain its stable layout path when realpath fails.
    }
    versions.push({ version: match[1] as string, path: resolvedPath });
  }

  return versions.sort((left, right) => compareVersionStrings(right.version, left.version));
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

function createFindings(
  defaultAlias: string | undefined,
  defaultVersion: string | undefined,
  currentVersion: string | undefined,
  versions: readonly ManagedVersion[]
): RuntimeFinding[] {
  const findings: RuntimeFinding[] = [];
  if (defaultAlias && !currentVersion) {
    findings.push({
      code: 'managed-but-not-on-path',
      params: {
        manager: 'nvm',
        defaultAlias,
        ...(defaultVersion !== undefined && { defaultVersion }),
      },
    });
  }

  for (const version of versions) {
    if (version.ltsStatus !== 'lts-outdated-patch' && version.ltsStatus !== 'lts-superseded') {
      continue;
    }
    findings.push({
      code: 'outdated-lts',
      params: { version: version.version, ltsStatus: version.ltsStatus },
    });
  }
  return findings;
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
  const currentPath = options.currentNodePath
    ? normalizedPath(options.currentNodePath, deps.platform)
    : undefined;
  const currentVersion = installedVersions.find(
    (version) => normalizedPath(version.path, deps.platform) === currentPath
  )?.version;
  const versions: ManagedVersion[] = installedVersions.map((version) => {
    const releaseLine = findNodeReleaseLine(options.schedule, version.version);
    return {
      version: version.version,
      path: version.path,
      isDefault: version.version === defaultVersion,
      isCurrent: version.version === currentVersion,
      ltsStatus: classifyNodeLtsStatus(version.version, options.schedule, {
        now: options.now,
        latestByMajor,
        liveDataAvailable: options.liveDataAvailable,
      }),
      ...(releaseLine?.codename !== undefined && { ltsCodename: releaseLine.codename }),
    };
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
    findings: createFindings(defaultAlias, defaultVersion, currentVersion, versions),
  };
}
