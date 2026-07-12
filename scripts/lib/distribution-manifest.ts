import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { NPM_PLATFORMS, platformPackageName } from './npm-pack';
import {
  ALL_BINARY_TARGETS,
  type ReleasePlatformId,
  releaseArchiveFileName,
} from './release-targets';

export const DISTRIBUTION_MANIFEST_SCHEMA_VERSION = 1;
export const DISTRIBUTION_MANIFEST_FILE = 'distribution-manifest.json';

export interface DistributionFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface DistributionTarget {
  readonly id: ReleasePlatformId;
  readonly bunTarget: string;
  readonly binary: string;
  readonly archive: string;
  readonly archiveMembers: readonly string[];
  readonly npmPackage: { readonly name: string; readonly directory: string } | null;
}

export interface DistributionManifest {
  readonly schemaVersion: typeof DISTRIBUTION_MANIFEST_SCHEMA_VERSION;
  readonly sourceSha: string;
  readonly dirty: boolean;
  readonly packageVersion: string;
  readonly channel: string;
  readonly bunVersion: string;
  readonly targets: readonly DistributionTarget[];
  readonly files: readonly DistributionFile[];
}

export interface CreateDistributionManifestOptions {
  readonly rootDir: string;
  readonly sourceSha: string;
  readonly dirty: boolean;
  readonly packageVersion: string;
  readonly channel: string;
  readonly bunVersion: string;
}

export interface ValidateDistributionManifestOptions {
  readonly rootDir: string;
  readonly sourceSha: string;
  readonly packageVersion: string;
  readonly channel?: string;
  readonly target?: string;
  readonly scope?: 'all' | 'packaged';
}

const MANIFEST_ROOTS = ['.mango/out', 'release-assets', 'dist-npm'] as const;

export function createDistributionManifest(
  options: CreateDistributionManifestOptions
): DistributionManifest {
  const targets = ALL_BINARY_TARGETS.map((target) => {
    const npmPlatform = NPM_PLATFORMS.find((platform) => platform.arch === target.arch);
    const sourceDir = join(options.rootDir, '.mango', 'out', target.arch);
    const archiveMembers = [
      target.name,
      ...(existsSync(join(sourceDir, 'cursor-sidecar')) ? ['cursor-sidecar'] : []),
      'README.md',
    ];

    return {
      id: target.arch,
      bunTarget: target.target,
      binary: `.mango/out/${target.arch}/${target.name}`,
      archive: `release-assets/${releaseArchiveFileName(options.packageVersion, target)}`,
      archiveMembers,
      npmPackage: npmPlatform
        ? {
            name: platformPackageName(npmPlatform),
            directory: `dist-npm/${npmPlatform.os}-${npmPlatform.cpu}`,
          }
        : null,
    } satisfies DistributionTarget;
  });

  const files = MANIFEST_ROOTS.flatMap((root) => collectFiles(options.rootDir, root)).sort((a, b) =>
    compareText(a.path, b.path)
  );

  assertUnique(
    targets.map((target) => target.id),
    'target identity'
  );
  assertUnique(
    files.map((file) => file.path),
    'file identity'
  );

  return {
    schemaVersion: DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
    sourceSha: normalizeSha(options.sourceSha),
    dirty: options.dirty,
    packageVersion: options.packageVersion,
    channel: options.channel,
    bunVersion: options.bunVersion,
    targets,
    files,
  };
}

export function parseDistributionManifest(raw: string): DistributionManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Distribution manifest is not valid JSON: ${String(cause)}`);
  }

  if (!isRecord(value)) throw new Error('Distribution manifest must be an object.');
  if (value.schemaVersion !== DISTRIBUTION_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported distribution manifest schema: ${String(value.schemaVersion)}`);
  }
  for (const key of ['sourceSha', 'packageVersion', 'channel', 'bunVersion'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Distribution manifest field ${key} must be a non-empty string.`);
    }
  }
  if (typeof value.dirty !== 'boolean') {
    throw new Error('Distribution manifest field dirty must be a boolean.');
  }
  if (!Array.isArray(value.targets) || !Array.isArray(value.files)) {
    throw new Error('Distribution manifest targets and files must be arrays.');
  }

  const targets = value.targets.map(parseTarget);
  const files = value.files.map(parseFile);
  assertUnique(
    targets.map((target) => target.id),
    'target identity'
  );
  assertUnique(
    files.map((file) => file.path),
    'file identity'
  );

  return {
    schemaVersion: DISTRIBUTION_MANIFEST_SCHEMA_VERSION,
    sourceSha: normalizeSha(value.sourceSha as string),
    dirty: value.dirty,
    packageVersion: value.packageVersion as string,
    channel: value.channel as string,
    bunVersion: value.bunVersion as string,
    targets,
    files,
  };
}

export function readDistributionManifest(path: string): DistributionManifest {
  if (!existsSync(path)) throw new Error(`Missing distribution manifest: ${path}`);
  return parseDistributionManifest(readFileSync(path, 'utf8'));
}

export function validateDistributionManifest(
  manifest: DistributionManifest,
  options: ValidateDistributionManifestOptions
): void {
  const expectedSha = normalizeSha(options.sourceSha);
  if (manifest.sourceSha !== expectedSha) {
    throw new Error(
      `Distribution source SHA mismatch: expected ${expectedSha}, got ${manifest.sourceSha}`
    );
  }
  if (manifest.packageVersion !== options.packageVersion) {
    throw new Error(
      `Distribution version mismatch: expected ${options.packageVersion}, got ${manifest.packageVersion}`
    );
  }
  if (options.channel && manifest.channel !== options.channel) {
    throw new Error(
      `Distribution channel mismatch: expected ${options.channel}, got ${manifest.channel}`
    );
  }

  const target = options.target
    ? manifest.targets.find((candidate) => candidate.id === options.target)
    : undefined;
  if (options.target && !target) {
    throw new Error(`Distribution target is missing from manifest: ${options.target}`);
  }

  const files = selectFiles(manifest, target, options.scope ?? 'all');
  if (files.length === 0) throw new Error('Distribution manifest selected no files to validate.');
  for (const file of files) validateFile(options.rootDir, file);
}

export function distributionArtifactName(
  kind: string,
  sourceSha: string,
  packageVersion: string,
  bundleSha256: string
): string {
  const normalizedSourceSha = normalizeSha(sourceSha);
  if (!/^[a-f0-9]{64}$/.test(bundleSha256)) {
    throw new Error(`Invalid distribution bundle SHA-256: ${bundleSha256}`);
  }
  return `distribution-${sanitizeName(kind)}-${normalizedSourceSha.slice(0, 12)}-${sanitizeName(packageVersion)}-${bundleSha256.slice(0, 12)}`;
}

export function assertSafeDistributionArchiveEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    const segments = normalized.split('/').filter(Boolean);
    if (
      normalized.length === 0 ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.includes('\0') ||
      segments.includes('..')
    ) {
      throw new Error(`Unsafe distribution archive entry: ${entry}`);
    }
  }
}

function collectFiles(rootDir: string, relativeRoot: string): DistributionFile[] {
  const absoluteRoot = join(rootDir, relativeRoot);
  if (!existsSync(absoluteRoot)) throw new Error(`Missing distribution directory: ${absoluteRoot}`);

  const files: DistributionFile[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      compareText(a.name, b.name)
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        const contents = readFileSync(path);
        files.push({
          path: toPosix(relative(rootDir, path)),
          size: contents.byteLength,
          sha256: createHash('sha256').update(contents).digest('hex'),
        });
      } else {
        throw new Error(`Distribution contains unsupported filesystem entry: ${path}`);
      }
    }
  };
  visit(absoluteRoot);
  return files;
}

function selectFiles(
  manifest: DistributionManifest,
  target: DistributionTarget | undefined,
  scope: 'all' | 'packaged'
): DistributionFile[] {
  if (target) {
    return manifest.files.filter(
      (file) =>
        file.path.startsWith(`.mango/out/${target.id}/`) ||
        file.path === target.archive ||
        file.path === 'release-assets/SHA256SUMS'
    );
  }
  if (scope === 'packaged') {
    return manifest.files.filter(
      (file) => file.path.startsWith('release-assets/') || file.path.startsWith('dist-npm/')
    );
  }
  return [...manifest.files];
}

function validateFile(rootDir: string, file: DistributionFile): void {
  const path = resolve(rootDir, file.path);
  const relativePath = relative(resolve(rootDir), path);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
    throw new Error(`Distribution manifest path escapes the workspace: ${file.path}`);
  }
  if (!existsSync(path)) throw new Error(`Distribution file is missing: ${file.path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Distribution entry is not a file: ${file.path}`);
  if (stat.size !== file.size) {
    throw new Error(
      `Distribution size mismatch for ${file.path}: expected ${file.size}, got ${stat.size}`
    );
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== file.sha256) {
    throw new Error(
      `Distribution SHA-256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`
    );
  }
}

function parseTarget(value: unknown, index: number): DistributionTarget {
  if (!isRecord(value)) throw new Error(`Distribution target ${index} must be an object.`);
  for (const key of ['id', 'bunTarget', 'binary', 'archive'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`Distribution target ${index}.${key} must be a non-empty string.`);
    }
  }
  if (!ALL_BINARY_TARGETS.some((target) => target.arch === value.id)) {
    throw new Error(`Distribution target ${index} has unsupported id: ${String(value.id)}`);
  }
  if (
    !Array.isArray(value.archiveMembers) ||
    value.archiveMembers.some((member) => typeof member !== 'string' || member.length === 0)
  ) {
    throw new Error(`Distribution target ${index}.archiveMembers must contain strings.`);
  }
  const npmPackage = value.npmPackage;
  if (
    npmPackage !== null &&
    (!isRecord(npmPackage) ||
      typeof npmPackage.name !== 'string' ||
      typeof npmPackage.directory !== 'string')
  ) {
    throw new Error(`Distribution target ${index}.npmPackage is invalid.`);
  }
  return value as unknown as DistributionTarget;
}

function parseFile(value: unknown, index: number): DistributionFile {
  if (!isRecord(value)) throw new Error(`Distribution file ${index} must be an object.`);
  if (typeof value.path !== 'string' || value.path.length === 0) {
    throw new Error(`Distribution file ${index}.path must be a non-empty string.`);
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) {
    throw new Error(`Distribution file ${index}.size must be a non-negative integer.`);
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`Distribution file ${index}.sha256 must be a lowercase SHA-256 digest.`);
  }
  return value as unknown as DistributionFile;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate distribution ${label}: ${value}`);
    seen.add(value);
  }
}

function normalizeSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(normalized)) {
    throw new Error(`Invalid source SHA: ${value}`);
  }
  return normalized;
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
