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
