/**
 * POSIX shell rendering for an argv, shared because two surfaces must agree on
 * it: the API builds the copyable command from it, and the frontend shows the
 * exact argv in the dialog that asks the user to approve running it. A second
 * implementation would let those two drift apart.
 */

/** Quotes one argument so a POSIX shell reads it back as the same string. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Renders an argv as a single shell line, each argument quoted as needed. */
export function renderShellCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}
