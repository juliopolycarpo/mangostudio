/**
 * What a `gh` invocation is allowed to look like in a log line.
 *
 * Both ends write one: the runtime records the call it served in its audit
 * log, and the hub records the same call when it fails a route. They have to
 * redact identically — a summary the hub kept in full would leak exactly what
 * the runtime's line was written to withhold.
 */

/**
 * Summarizes a recognized `gh` operation for audit lines.
 *
 * Never the full argv: `gh pr create --title ... --body ...` carries prose a
 * user wrote, and the audit scrubber is best-effort pattern matching. Two
 * tokens name a recognized operation; unknown tokens may themselves be prose.
 *
 * @example
 * summarizeGhSubcommand(['pr', 'create', '--title', 'Fix']); // ['pr', 'create']
 */
export function summarizeGhSubcommand(args: readonly unknown[]): readonly string[] {
  if (args.length === 1 && args[0] === '--version') return ['--version'];
  const [command, operation] = args;
  if (typeof command !== 'string' || typeof operation !== 'string') return [];
  return AUDIT_OPERATIONS.has(`${command} ${operation}`) ? [command, operation] : [];
}

const AUDIT_OPERATIONS: ReadonlySet<string> = new Set([
  'auth status',
  'repo view',
  'pr view',
  'pr list',
  'pr status',
  'pr checks',
  'issue list',
  'search prs',
  'api graphql',
  'pr create',
  'pr ready',
  'pr checkout',
]);
