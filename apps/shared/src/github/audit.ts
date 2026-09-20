/**
 * What a `gh` invocation is allowed to look like in a log line.
 *
 * Both ends write one: the runtime records the call it served in its audit
 * log, and the hub records the same call when it fails a route. They have to
 * redact identically — a summary the hub kept in full would leak exactly what
 * the runtime's line was written to withhold.
 */

/**
 * Summarizes a `gh` argv down to its subcommand tokens, for audit lines.
 *
 * Never the full argv: `gh pr create --title ... --body ...` carries prose a
 * user wrote, and the audit scrubber is best-effort pattern matching. Two
 * tokens name the operation, which is what an audit trail is for.
 *
 * @example
 * summarizeGhSubcommand(['pr', 'create', '--title', 'Fix']); // ['pr', 'create']
 */
export function summarizeGhSubcommand(args: readonly unknown[]): readonly string[] {
  return args.filter((entry): entry is string => typeof entry === 'string').slice(0, 2);
}
