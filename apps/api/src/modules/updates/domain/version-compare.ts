/**
 * Version-string semantics for the updates module: what counts as a version,
 * how a leading `v` is normalized away, how two stable versions order, and
 * when two source shas name the same commit. Shared by `update-check.ts` (is
 * the latest release actually newer?) and `resolve-target.ts` (has an unpinned
 * upgrade already caught up?). Neither one can use plain string (in)equality:
 * a yanked release drops the latest tag back a version, and `"0.1.10" !==
 * "0.1.9"` is true but says nothing about which is newer.
 */

import { UPGRADE_VERSION_PATTERN } from '@mangostudio/shared/updates';

/**
 * The same shape the wire and CLI boundaries accept — built from the shared
 * pattern rather than copied, so loosening one cannot leave this stricter and
 * make `isAlreadyCurrent` answer "no" for a version the API took.
 */
const VERSION_SHAPE = new RegExp(UPGRADE_VERSION_PATTERN);

/**
 * Whether a string is a version this module can order at all. A caller that
 * asks "is this already current?" about something that is not a version must
 * hear "no" — a malformed value read as older than everything would otherwise
 * be waved through as up to date. // Usage: isVersionShaped('0.1.1') // true
 */
export function isVersionShaped(version: string): boolean {
  return VERSION_SHAPE.test(version);
}

/**
 * Strips a leading `v`, the same normalization `install.sh`'s
 * `normalize_version` applies to a pinned version — a rule that has to match
 * the shell installer, so it is stated in one place.
 * // Usage: stripLeadingV('v0.1.1') // '0.1.1'
 */
export function stripLeadingV(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Whether two source shas agree on at least their first `minLength`
 * characters — how "is the running build this commit?" is decided, at the
 * short-sha length every release artifact carries.
 * // Usage: sharesShaPrefix('abc1234def', 'ABC1234') // true
 */
export function sharesShaPrefix(a: string, b: string, minLength = 7): boolean {
  const len = Math.min(a.length, b.length, Math.max(minLength, 0));
  let common = 0;
  while (common < len && a[common]?.toLowerCase() === b[common]?.toLowerCase()) common += 1;
  return common >= minLength;
}

function parseRootSegments(root: string): readonly [number, number, number] {
  const parts = root.split('.');
  const toNumber = (part: string | undefined): number => {
    const parsed = part === undefined ? Number.NaN : Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [toNumber(parts[0]), toNumber(parts[1]), toNumber(parts[2])];
}

/**
 * Compares two version strings by their `x.y.z` root, ignoring everything
 * from the first `-` on — except as a tie-break when both roots match: a
 * plain release outranks its own prerelease, the same precedence rule
 * semver gives `1.0.0` over `1.0.0-alpha`. So `0.1.5` (stable) reads as
 * newer than `0.1.5-canary.deadbee` even though canary is often ahead of
 * stable in practice — this compare only ever runs on the stable channel,
 * where a same-root prerelease means a build still labeled off the last
 * cut. Canary itself stays sha/version based and never calls this.
 *
 * Returns -1, 0, or 1 — never a lexical comparison, so "0.1.10" correctly
 * outranks "0.1.9".
 * // Usage: compareStableVersions('0.1.5', '0.1.4') // 1
 */
export function compareStableVersions(a: string, b: string): number {
  const strippedA = stripLeadingV(a);
  const strippedB = stripLeadingV(b);
  const rootA = strippedA.split('-')[0] ?? strippedA;
  const rootB = strippedB.split('-')[0] ?? strippedB;

  const segmentsA = parseRootSegments(rootA);
  const segmentsB = parseRootSegments(rootB);
  for (let i = 0; i < 3; i += 1) {
    if (segmentsA[i] !== segmentsB[i]) return segmentsA[i] > segmentsB[i] ? 1 : -1;
  }

  const hasPrereleaseA = strippedA.includes('-');
  const hasPrereleaseB = strippedB.includes('-');
  if (hasPrereleaseA === hasPrereleaseB) return 0;
  return hasPrereleaseA ? -1 : 1;
}
