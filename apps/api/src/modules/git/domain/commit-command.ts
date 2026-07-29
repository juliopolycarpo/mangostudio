const IDENT_TIMESTAMP_PATTERN = /\s+\d+\s+[+-]\d{4}$/;

/**
 * Reduces `git var GIT_COMMITTER_IDENT` to the `Name <email>` that `--signoff`
 * writes into the trailer. Returns `undefined` when git has no usable identity,
 * which is also when it would refuse to commit at all.
 */
export function parseCommitterIdentity(raw: string): string | undefined {
  const identity = raw.trim().replace(IDENT_TIMESTAMP_PATTERN, '').trim();
  return identity.length > 0 ? identity : undefined;
}

interface BuildCommitArgsOptions {
  readonly title: string;
  readonly body?: string;
  readonly amend: boolean;
  readonly signOff: boolean;
  readonly signCommits: boolean;
}

/** Builds the direct Git argv separately from execution so signing stays unit-testable. */
export function buildCommitArgs(options: BuildCommitArgsOptions): string[] {
  return [
    'commit',
    '-m',
    options.title,
    ...(options.body ? ['-m', options.body] : []),
    ...(options.amend ? ['--amend'] : []),
    ...(options.signOff ? ['--signoff'] : []),
    ...(options.signCommits ? ['--gpg-sign'] : []),
  ];
}
