// Project-owned interface around git-cliff. Keeps git-cliff argument shapes and
// the PR preview formatting in one testable place; scripts/changelog.ts wires
// these to the actual binary.

/** Default base ref the PR preview diffs against. */
export const DEFAULT_PREVIEW_BASE = 'origin/main';

/** Sticky-comment marker for the PR changelog preview bot. */
export const PREVIEW_MARKER = '<!-- changelog-preview-comment -->';

export type ChangelogMode =
  | { readonly kind: 'init'; readonly version: string }
  | { readonly kind: 'preview'; readonly base: string }
  | { readonly kind: 'release'; readonly version: string };

export interface CliffResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export type CliffRunner = (args: readonly string[]) => CliffResult;

const stripLeadingV = (version: string): string => version.replace(/^v/, '');

/** git-cliff arguments for a changelog mode. */
export function cliffArgs(mode: ChangelogMode): string[] {
  switch (mode.kind) {
    case 'init':
    case 'release':
      return ['--tag', `v${stripLeadingV(mode.version)}`, '--output', 'CHANGELOG.md'];
    case 'preview':
      return ['--strip', 'all', `${mode.base}..HEAD`];
  }
}

/** The release heading line prefix cliff.toml's body template writes for a
 * version, e.g. `## [0.1.0]`.
 * // Usage: releaseHeading('v0.1.0') -> '## [0.1.0]' */
export function releaseHeading(version: string): string {
  return `## [${stripLeadingV(version)}]`;
}

/** Assert a generated CHANGELOG.md already contains the release section for
 * `version`. The release workflow gates on this before building any artifact:
 * the changelog lands on main in the release-prep commit, before the tag.
 * // Usage: assertChangelogHasRelease(readFileSync('CHANGELOG.md', 'utf8'), '0.2.0') */
export function assertChangelogHasRelease(changelog: string, version: string): void {
  const heading = releaseHeading(version);
  if (changelog.split('\n').some((line) => line.startsWith(heading))) {
    return;
  }
  throw new Error(
    `CHANGELOG.md has no "${heading}" release section. The changelog must land on main ` +
      `before the tag: run \`bun run release:prepare ${stripLeadingV(version)}\`, commit the ` +
      `result, and tag that commit.`
  );
}

/** Wrap a git-cliff preview body as the sticky PR comment (with its marker). */
export function wrapPreviewComment(body: string): string {
  const trimmed = body.trim();
  const content =
    trimmed.length > 0 ? trimmed : '_No changelog-relevant commits on this branch yet._';
  return [
    '## 📝 Changelog Preview',
    '',
    'Entries this branch would add to the changelog on release:',
    '',
    content,
    '',
    PREVIEW_MARKER,
  ].join('\n');
}

/** Run a changelog mode through an injected git-cliff runner. */
export function runChangelog(
  mode: ChangelogMode,
  run: CliffRunner
): { output: string; exitCode: number } {
  const result = run(cliffArgs(mode));
  const output = mode.kind === 'preview' ? wrapPreviewComment(result.stdout) : result.stdout;
  return { output, exitCode: result.exitCode };
}

/** Parse changelog CLI args into a mode, or null to print usage.
 * `initialVersion` is the resolved baseline for `--init`; an explicit
 * `--init <version>` overrides it.
 * // Usage: parseChangelogArgs(process.argv.slice(2), rootReleaseVersion()) */
export function parseChangelogArgs(
  argv: readonly string[],
  initialVersion: string
): ChangelogMode | null {
  if (argv.includes('--help') || argv.length === 0) return null;

  const initIndex = argv.indexOf('--init');
  if (initIndex !== -1) {
    const explicit = argv[initIndex + 1];
    const version = explicit && !explicit.startsWith('--') ? explicit : initialVersion;
    return { kind: 'init', version };
  }

  const releaseIndex = argv.indexOf('--release');
  if (releaseIndex !== -1) {
    const version = argv[releaseIndex + 1];
    if (!version || version.startsWith('--')) return null;
    return { kind: 'release', version };
  }

  if (argv.includes('--preview')) {
    const baseIndex = argv.indexOf('--base');
    const base = baseIndex !== -1 ? argv[baseIndex + 1] : undefined;
    return { kind: 'preview', base: base && !base.startsWith('--') ? base : DEFAULT_PREVIEW_BASE };
  }

  return null;
}
