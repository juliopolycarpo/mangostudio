/**
 * What `mangostudio upgrade` should fetch, resolved from a channel (plus an
 * optional pin) and the platform asking.
 *
 * Three sources, one per shape of request: the GitHub release index for a
 * stable version or the rolling canary tag (`release-index.ts`), and the npm
 * registry for a canary build pinned to a source commit (`npm-registry.ts`),
 * since a per-commit canary is never republished under a tag the way the
 * rolling one is. `resolveUpgradeTarget` is the one place that picks between
 * them; nothing downstream re-derives an asset name or URL on its own.
 */

import type { UpdateChannel, UpgradeTarget } from '@mangostudio/shared/updates';
import type { SafeFetchDeps } from '../../../lib/safe-fetch';
import { resolveRuntimeRelease } from '../../environments/domain/runtime-release-resolution';
import { releaseAssetUrl } from '../../environments/domain/wsl-runtime-release';
import {
  fetchNpmPackument,
  findCanaryVersionForSha,
  npmPackageForPlatform,
} from '../infrastructure/npm-registry';
import {
  fetchCanaryManifestForTag,
  resolveCanaryRollingVersion,
  resolveStableLatestVersion,
} from '../infrastructure/release-index';
import type { ReleasePlatformId } from './platform-id';
import { compareStableVersions } from './version-compare';

export interface UpgradeTargetRequest {
  readonly channel: UpdateChannel;
  /** Stable only: an exact version instead of the latest. */
  readonly version?: string;
  /** Canary only: a pinned source commit instead of the rolling latest. */
  readonly sha?: string;
}

export interface UpgradeTargetContext {
  readonly platformId: ReleasePlatformId;
  readonly currentVersion: string;
  /** This build's own source commit, when it is a canary build. */
  readonly buildSha?: string;
}

/** Only refusal this resolver produces; every other refusal reason belongs to `upgrade-plan.ts`'s per-origin table. */
export interface UpgradeTargetRefusal {
  readonly reason: 'unsupported-target';
  readonly message: string;
}

/** What verified the download, carried alongside the wire-shape `UpgradeTarget`. */
export type ExpectedDigest =
  | { readonly algorithm: 'sha256'; readonly hex: string }
  | { readonly algorithm: 'sha512'; readonly hex: string };

/**
 * A resolved target plus what `downloadVerified` checks it against — the two
 * shapes discriminated on `verification`, the same field `UpgradeTarget`
 * already carries over the wire. An archive target names the SHA256SUMS URl
 * to fetch and search at download time; an npm target already has its digest,
 * since the registry handed it back with the packument.
 */
export interface ResolvedArchiveDownload extends UpgradeTarget {
  readonly kind: 'archive';
  readonly verification: 'sha256-sums';
  readonly checksumsUrl: string;
}
export interface ResolvedNpmDownload extends UpgradeTarget {
  readonly kind: 'npm-tarball';
  readonly verification: 'npm-integrity';
  readonly expectedDigest: ExpectedDigest;
}
export type ResolvedDownload = ResolvedArchiveDownload | ResolvedNpmDownload;

function hubArchiveExtension(platformId: ReleasePlatformId): 'zip' | 'tar.gz' {
  return platformId.startsWith('windows-') ? 'zip' : 'tar.gz';
}

/**
 * The hub release archive's asset name for one version and platform. Distinct
 * from `wsl-runtime-release.ts`'s `releaseArchiveName` (always `.tar.gz`,
 * since WSL only ever targets Linux): the hub archive ships on Windows too,
 * as a `.zip`, and has to match what `install.ps1`/`install.sh` fetch.
 * // Usage: hubArchiveName('1.2.3', 'windows-x64') // 'mangostudio-1.2.3-windows-x64.zip'
 */
export function hubArchiveName(version: string, platformId: ReleasePlatformId): string {
  return `mangostudio-${version}-${platformId}.${hubArchiveExtension(platformId)}`;
}

function stableAsset(version: string, platformId: ReleasePlatformId): ResolvedArchiveDownload {
  const assetName = hubArchiveName(version, platformId);
  return {
    channel: 'stable',
    version,
    assetName,
    url: releaseAssetUrl(version, assetName),
    kind: 'archive',
    verification: 'sha256-sums',
    checksumsUrl: releaseAssetUrl(version, 'SHA256SUMS'),
  };
}

/** Strips a leading `v`, the same normalization `install.sh`'s `normalize_version` applies to a pinned version. */
function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

async function resolveStableTarget(
  request: UpgradeTargetRequest,
  context: UpgradeTargetContext,
  deps: SafeFetchDeps
): Promise<ResolvedArchiveDownload> {
  const version = request.version
    ? normalizeVersion(request.version)
    : await resolveStableLatestVersion(deps);
  return stableAsset(version, context.platformId);
}

/**
 * The rolling canary tag's version, without a network round trip when this
 * build is already canary: `resolveRuntimeRelease` reads it straight off the
 * running version, since a canary hub's own tag never depends on what else
 * has since been published. Only a stable build has to ask GitHub which tag
 * is current.
 *
 * A canary build therefore only ever sees its own root's rolling tag this
 * way: a root bump (`0.1.1-canary` moving to `0.1.2-canary`) is invisible to
 * it until something else — a stable-relative read, or a later upgrade —
 * moves it onto the new root.
 */
function resolveCanaryTagVersion(
  context: UpgradeTargetContext,
  deps: SafeFetchDeps
): Promise<string> {
  const currentRelease = resolveRuntimeRelease(context.currentVersion, context.platformId);
  return currentRelease.channel === 'canary'
    ? Promise.resolve(currentRelease.tagVersion)
    : resolveCanaryRollingVersion(deps);
}

async function resolveCanaryLatest(
  context: UpgradeTargetContext,
  deps: SafeFetchDeps
): Promise<ResolvedArchiveDownload> {
  const tagVersion = await resolveCanaryTagVersion(context, deps);
  const manifest = await fetchCanaryManifestForTag(deps, tagVersion);
  const version = manifest?.version ?? tagVersion;
  const assetName = hubArchiveName(tagVersion, context.platformId);
  return {
    channel: 'canary',
    version,
    ...(manifest ? { sourceSha: manifest.sourceSha } : {}),
    assetName,
    url: releaseAssetUrl(tagVersion, assetName),
    kind: 'archive',
    verification: 'sha256-sums',
    checksumsUrl: releaseAssetUrl(tagVersion, 'SHA256SUMS'),
  };
}

const NPM_INTEGRITY = /^(sha256|sha512)-([A-Za-z0-9+/=]+)$/;

/** Parses an npm `dist.integrity` SRI string into the digest `downloadVerified` checks against. */
function parseNpmIntegrity(integrity: string): ExpectedDigest | null {
  const match = NPM_INTEGRITY.exec(integrity.trim());
  if (!match) return null;
  const algorithm = match[1] as 'sha256' | 'sha512';
  const base64 = match[2];
  if (base64 === undefined) return null;
  return { algorithm, hex: Buffer.from(base64, 'base64').toString('hex') };
}

function tarballAssetName(tarballUrl: string): string {
  const path = new URL(tarballUrl).pathname;
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The unsupported-target refusal for a canary `<sha>` request npm cannot
 * serve: musl has no npm optional-dependency package (see `install.sh` /
 * `packages/cli/bin/mangostudio.js`'s platform table), so it names the two
 * channels that do cover it.
 */
function muslShaRefusal(platformId: ReleasePlatformId): UpgradeTargetRefusal {
  return {
    reason: 'unsupported-target',
    message:
      `${platformId} has no npm package to resolve a per-commit canary build from. ` +
      'Use --canary for the rolling latest canary, or the shell installer, instead.',
  };
}

async function resolveCanaryBySha(
  sha: string,
  context: UpgradeTargetContext,
  deps: SafeFetchDeps
): Promise<ResolvedNpmDownload | UpgradeTargetRefusal> {
  const packageName = npmPackageForPlatform(context.platformId);
  if (!packageName) return muslShaRefusal(context.platformId);

  const packument = await fetchNpmPackument(packageName, deps);
  const version = findCanaryVersionForSha(packument, sha);
  if (!version) {
    throw new Error(`No version of ${packageName} on npm matches source commit ${sha}.`);
  }

  const dist = packument.versions[version]?.dist;
  if (!dist) {
    throw new Error(`npm packument is missing dist metadata for ${version}.`);
  }
  const digest = dist.integrity ? parseNpmIntegrity(dist.integrity) : null;
  if (!digest) {
    throw new Error(`npm packument for ${packageName}@${version} has no usable integrity hash.`);
  }

  return {
    channel: 'canary',
    version,
    sourceSha: sha,
    assetName: tarballAssetName(dist.tarball),
    url: dist.tarball,
    kind: 'npm-tarball',
    verification: 'npm-integrity',
    expectedDigest: digest,
  };
}

/**
 * Resolves a request into a downloadable, verifiable target — or the one
 * refusal this resolver itself can produce.
 * // Usage: resolveUpgradeTarget({ channel: 'canary' }, { platformId: 'linux-x64', currentVersion: '0.1.1' }, { fetch })
 */
export function resolveUpgradeTarget(
  request: UpgradeTargetRequest,
  context: UpgradeTargetContext,
  deps: SafeFetchDeps
): Promise<ResolvedDownload | UpgradeTargetRefusal> {
  if (request.channel === 'stable') return resolveStableTarget(request, context, deps);
  if (request.sha) return resolveCanaryBySha(request.sha, context, deps);
  return resolveCanaryLatest(context, deps);
}

/**
 * True when a resolved target is what the caller is already running, or —
 * for an unpinned stable target — is not even newer. An explicit
 * `--version x.y.z` pin is a deliberate choice, including a downgrade, so it
 * only ever matches on exact equality; the rolling "latest" target has no
 * such intent behind it; a yanked release can leave it behind the version
 * already installed, and that must read as "nothing to do" rather than as a
 * downgrade the caller never asked for.
 * // Usage: isAlreadyCurrent(target, { currentVersion: '0.1.1' })
 */
export function isAlreadyCurrent(
  target: UpgradeTarget,
  context: {
    readonly currentVersion: string;
    readonly buildSha?: string;
    readonly pinned?: boolean;
  }
): boolean {
  if (target.channel === 'stable') {
    if (context.pinned) return target.version === context.currentVersion;
    return compareStableVersions(target.version, context.currentVersion) <= 0;
  }
  if (target.version === context.currentVersion) return true;

  const a = target.sourceSha?.toLowerCase();
  const b = context.buildSha?.toLowerCase();
  if (!a || !b) return false;
  const prefixLength = Math.min(a.length, b.length, 7);
  return prefixLength >= 7 && a.slice(0, 7) === b.slice(0, 7);
}
