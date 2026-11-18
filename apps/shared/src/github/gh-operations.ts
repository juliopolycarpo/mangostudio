/**
 * The `gh` operations the runtime lets a caller run, declared once.
 *
 * Three readers derive from these lists: the hub's audit summaries
 * (`summarizeGhSubcommand`), `strings.json` in the runtime contract, and the
 * Rust runtime's `gh_policy`, which loads the emitted copy. An operation added
 * here reaches all three through `bun run contracts:emit`; an artifact left
 * stale fails the freshness check.
 *
 * `gh --version` is not listed: both sides treat it as a one-token call.
 */

/** Operations `gh.exec` runs: they only read. Order is the order the runtime's refusal lists them. */
export const GH_READ_OPERATIONS: readonly string[] = Object.freeze([
  'auth status',
  'repo view',
  'pr view',
  'pr list',
  'pr status',
  'pr checks',
  'issue list',
  'search prs',
  'api graphql',
]);

/** Operations `gh.mutate` runs: they change something on GitHub or in the checkout. */
export const GH_WRITE_OPERATIONS: readonly string[] = Object.freeze([
  'pr create',
  'pr ready',
  'pr checkout',
]);
