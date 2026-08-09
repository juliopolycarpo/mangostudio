/**
 * Reading and comparing the version of whatever `codex` the scanner resolved.
 *
 * `initialize`'s result carries no protocol version — it returns `codexHome`,
 * `platformFamily`, `platformOs` and `userAgent` and nothing else — so the only
 * thing that can gate the contract is the CLI's own `--version` output.
 *
 * The parse is deliberately loose about everything except the number. Codex
 * installed from npm, from Bun, from Homebrew or as a downloaded binary all
 * print `codex-cli <semver>` today, but the prefix is a display string and a
 * build that changes it is not a build that broke the protocol. What must be
 * strict is the comparison: a version that cannot be parsed is `undefined`
 * rather than a guess, and an unparseable version never satisfies the minimum.
 */

/** A parsed `major.minor.patch`, with any pre-release or build metadata dropped. */
export interface CodexVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The matched `major.minor.patch` text, for display and error messages. */
  readonly text: string;
}

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

/**
 * Pulls the first `major.minor.patch` out of a `codex --version` line.
 *
 * Returns `undefined` when there is no such token. Callers treat that as "not
 * established" and never as "old enough" or "new enough" — an unknown version
 * is the one case where both answers are wrong.
 */
export function parseCodexVersion(raw: string): CodexVersion | undefined {
  const match = VERSION_PATTERN.exec(raw);
  if (!match) return undefined;
  const [text, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    text: text ?? '',
  };
}

/** Negative when `left` is older, zero when equal, positive when newer. */
export function compareCodexVersions(left: CodexVersion, right: CodexVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * Whether an observed version may drive the vendored contract.
 *
 * Newer than the pin is allowed on purpose. `app-server` has been additive in
 * practice, the reducer ignores notification and item types it does not know,
 * and refusing to run against a Codex the user upgraded themselves would turn a
 * drift warning into an outage. Older is refused, because the vendored contract
 * describes methods that binary does not serve.
 */
export function isCodexVersionSupported(
  observed: CodexVersion | undefined,
  minimum: CodexVersion
): boolean {
  return observed !== undefined && compareCodexVersions(observed, minimum) >= 0;
}

/** The pinned minimum, parsed once so callers compare structures rather than strings. */
export function requireCodexVersion(raw: string): CodexVersion {
  const parsed = parseCodexVersion(raw);
  if (!parsed) throw new Error(`"${raw}" is not a parseable Codex version.`);
  return parsed;
}
