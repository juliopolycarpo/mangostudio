/**
 * Reading and comparing the version of whatever `claude` the scanner resolved.
 *
 * Version gates the *flags*, not the protocol. The record vocabulary on stdout
 * is additive and the reducer ignores what it does not recognize, so what a
 * version comparison is actually for here is knowing whether an argument this
 * adapter is about to pass exists — `--forward-subagent-text` above all, which
 * a pre-2.1.211 build rejects outright.
 *
 * Protocol *behaviour* is not read from here at all. The init record carries a
 * `capabilities` array naming what a build implements, and the reducer keeps it
 * on `ClaudeRunInit` for the drift probe to compare — but it arrives only once a
 * process is already running, which is too late to decide what to put in that
 * process's argv. Nothing in v1 branches on it, and a feature-detection helper
 * with no caller would be a claim that something does.
 */

import { parseClaudeVersion as parseSemVer } from '@mangostudio/shared/environments/detection';

/** A parsed `major.minor.patch`, with the `(Claude Code)` suffix dropped. */
export interface ClaudeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The matched `major.minor.patch` text, for display and error messages. */
  readonly text: string;
}

/**
 * Pulls the version out of a `claude --version` line.
 *
 * Delegates the shape to the shared scanner definition rather than keeping a
 * second pattern: the environment scanner and this adapter must agree about
 * what a Claude version is, or a build the Environments page calls 2.1.226
 * could be one this adapter calls unparseable.
 *
 * Returns `undefined` when there is no such token. Callers treat that as "not
 * established" and never as "old enough" or "new enough" — an unknown version
 * is the one case where both answers are wrong.
 */
export function parseClaudeVersion(raw: string): ClaudeVersion | undefined {
  const parsed = parseSemVer(raw.trim());
  if (!parsed) return undefined;
  return { ...parsed, text: `${parsed.major}.${parsed.minor}.${parsed.patch}` };
}

/** Negative when `left` is older, zero when equal, positive when newer. */
export function compareClaudeVersions(left: ClaudeVersion, right: ClaudeVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * Whether an observed version may drive this adapter.
 *
 * Newer than the pin is allowed: the stream vocabulary is additive, the reducer
 * tolerates unknown record types, and refusing a Claude the user upgraded
 * themselves would turn a drift warning into an outage. Older is refused,
 * because the argv this adapter builds names flags that binary does not have.
 */
export function isClaudeVersionSupported(
  observed: ClaudeVersion | undefined,
  minimum: ClaudeVersion
): boolean {
  return observed !== undefined && compareClaudeVersions(observed, minimum) >= 0;
}

/** The pinned minimum, parsed once so callers compare structures rather than strings. */
export function requireClaudeVersion(raw: string): ClaudeVersion {
  const parsed = parseClaudeVersion(raw);
  if (!parsed) throw new Error(`"${raw}" is not a parseable Claude Code version.`);
  return parsed;
}
