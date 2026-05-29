// Project-owned interface around git-cliff. Keeps git-cliff argument shapes and
// the PR preview formatting in one testable place; scripts/changelog.ts wires
// these to the actual binary.

/** Baseline version for the first generated changelog. */
export const INITIAL_VERSION = '0.1.0';

/** Default base ref the PR preview diffs against. */
export const DEFAULT_PREVIEW_BASE = 'origin/main';

/** Sticky-comment marker for the PR changelog preview bot. */
export const PREVIEW_MARKER = '<!-- changelog-preview-comment -->';

export type ChangelogMode =
  | { readonly kind: 'init' }
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
      return ['--tag', `v${INITIAL_VERSION}`, '--output', 'CHANGELOG.md'];
    case 'release':
      return ['--tag', `v${stripLeadingV(mode.version)}`, '--output', 'CHANGELOG.md'];
    case 'preview':
      return ['--strip', 'all', `${mode.base}..HEAD`];
  }
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

/** Parse changelog CLI args into a mode, or null to print usage. */
export function parseChangelogArgs(argv: readonly string[]): ChangelogMode | null {
  if (argv.includes('--help') || argv.length === 0) return null;
  if (argv.includes('--init')) return { kind: 'init' };

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
