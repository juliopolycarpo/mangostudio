/**
 * Where the Mango Protocol lives in this repository, and what its release train
 * is called.
 *
 * The protocol is one wire contract published three ways — the normative spec
 * under `spec/`, the TypeScript SDK under `packages/protocol/` and the Rust
 * crate under `crates/mango-protocol/` — on its own version line. It ships on a
 * `protocol-v*` tag prefix so the application's `release.yml`, which fires on an
 * anchored `v*.*.*`, never sees a protocol tag, and so git-cliff can tell the
 * two histories apart from one `tag_pattern`.
 *
 * @example
 * if (touchesProtocolSurface(changedFiles)) tasks.push(protocolCheckTask());
 */

/** Tag prefix for every protocol release; the application uses a bare `v`. */
export const PROTOCOL_TAG_PREFIX = 'protocol-v';

/** git-cliff configuration for the protocol changelog, relative to the repository root. */
export const PROTOCOL_CLIFF_CONFIG = 'packages/protocol/cliff.toml';

/** The protocol changelog, relative to the repository root. */
export const PROTOCOL_CHANGELOG = 'packages/protocol/CHANGELOG.md';

/**
 * Tip of the imported `juliopolycarpo/mango-protocol` history.
 *
 * The protocol arrived through one `--no-ff` merge of an unrelated root, with
 * its original SHAs preserved, so this repository has two disjoint histories.
 * `<this>..HEAD` is exactly "everything this repository committed", and it is
 * the only lever that separates the two for git-cliff: the imported commits
 * carry the *upstream* tree's root-relative paths (`docs/**`, `scripts/**`,
 * `README.md`, `package.json`), which collide with directories this repository
 * owns, so no path rule can tell them apart. git-cliff 2.13.1 has no
 * first-parent traversal either.
 *
 * @example
 * ['--output', 'CHANGELOG.md', `${PROTOCOL_IMPORT_TIP}..HEAD`];
 */
export const PROTOCOL_IMPORT_TIP = '97b458d8b5e47bf110106fb24b1dee501ee77f71';

/**
 * Every directory the protocol owns, as repository-relative path prefixes.
 *
 * This one list is the single definition behind the changelog partition, the
 * CI path filter and the scoped-run predicate below, so a new protocol
 * directory cannot be added to one and forgotten in the others.
 */
export const PROTOCOL_PATHS: readonly string[] = [
  'packages/protocol/',
  'crates/',
  'spec/',
  'docs/protocol/',
  'scripts/protocol/',
];

/**
 * Protocol-owned files that live outside `PROTOCOL_PATHS` and still belong to
 * the protocol's changelog, as git-cliff globs.
 *
 * The three `protocol-*.yml` workflows are the protocol's own CI, release and
 * fuzz lanes. Leaving them out of both configs sent every commit that touches
 * only them to the *application's* changelog and to neither of the protocol's:
 * measured on this tree, `ci(protocol): own CI, release and fuzz workflows` and
 * four of its siblings reached `CHANGELOG.md` and never
 * `packages/protocol/CHANGELOG.md`, the exact inversion the partition exists to
 * prevent.
 *
 * `scripts/lib/protocol.ts` and `scripts/tests/protocol-*.unit.test.ts` stay
 * out on purpose, for the reason `PROTOCOL_TOOLING_FILES` gives: they are the
 * application repository's own tooling about the protocol, not the protocol.
 */
const PROTOCOL_EXTRA_CHANGELOG_GLOBS: readonly string[] = ['.github/workflows/protocol-*.yml'];

/**
 * Every glob both git-cliff configs mirror — the root as `exclude_paths`, the
 * protocol's as `include_paths`. `protocol-changelog.unit.test.ts` holds the
 * three in step.
 *
 * @example
 * PROTOCOL_CHANGELOG_GLOBS.includes('spec/**'); // true
 */
export const PROTOCOL_CHANGELOG_GLOBS: readonly string[] = [
  ...PROTOCOL_PATHS.map((prefix) => `${prefix}**`),
  ...PROTOCOL_EXTRA_CHANGELOG_GLOBS,
];

/** Root files the protocol workspace owns outright. */
const PROTOCOL_ROOT_FILES: readonly string[] = [
  'Cargo.toml',
  'Cargo.lock',
  'deny.toml',
  'rustfmt.toml',
  'rust-toolchain.toml',
];

/**
 * Files outside the protocol directories that decide whether its lanes run.
 *
 * Kept apart from `PROTOCOL_PATHS`, which the two git-cliff configs mirror as
 * include/exclude globs: this module is the application repository's own
 * tooling and has no place in the protocol's changelog. It belongs to the lane
 * detection because it *is* the lane detection — an edit here reshapes the path
 * set, the CI filter derived from it and the release-note range, and the
 * detector that decided to skip the lanes would be running the pre-edit rules.
 */
const PROTOCOL_TOOLING_FILES: readonly string[] = ['scripts/lib/protocol.ts'];

/**
 * Every file the protocol lanes react to that is not under a protocol
 * directory. This is the list the CI path filter and the push trigger mirror;
 * the two halves above differ only in why they are on it.
 */
export const PROTOCOL_TRIGGER_FILES: readonly string[] = [
  ...PROTOCOL_ROOT_FILES,
  ...PROTOCOL_TOOLING_FILES,
];

/**
 * Whether a changed-file set can affect the protocol lanes.
 *
 * @example
 * touchesProtocolSurface(['spec/schema/1/protocol.json']); // true
 */
export function touchesProtocolSurface(files: readonly string[]): boolean {
  return files.some(
    (file) =>
      PROTOCOL_PATHS.some((prefix) => file.startsWith(prefix)) ||
      PROTOCOL_TRIGGER_FILES.includes(file)
  );
}

/**
 * The release tag for a version, with or without a leading `v` already applied.
 *
 * @example
 * protocolTag('v0.2.1'); // 'protocol-v0.2.1'
 */
export function protocolTag(version: string): string {
  return `${PROTOCOL_TAG_PREFIX}${version.replace(/^v/, '')}`;
}

/**
 * The version a protocol tag names, or null when the ref is not one.
 *
 * @example
 * protocolVersion('protocol-v0.2.1'); // '0.2.1'
 */
export function protocolVersion(tag: string): string | null {
  return tag.startsWith(PROTOCOL_TAG_PREFIX) ? tag.slice(PROTOCOL_TAG_PREFIX.length) : null;
}
