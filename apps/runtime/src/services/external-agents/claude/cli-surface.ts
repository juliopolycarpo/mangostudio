/**
 * What `claude --help` says this build offers, and whether that is enough.
 *
 * Claude has no handshake. Codex answers `initialize` and Cursor negotiates an
 * ACP version, but a `claude --print` turn is a one-shot process whose first
 * feedback about an argument it does not recognize is a non-zero exit after the
 * user already pressed send. `--help` is the only place the CLI describes its
 * own surface before anything is spawned in anger, so it is what this adapter
 * probes.
 *
 * This is deliberately a better gate than the version number. `pinned.ts`
 * records **2.1.211** because that is where `--forward-subagent-text` arrived,
 * but the version is a proxy for the flag and the flag is the thing that
 * matters: a repackaged build, a vendor that backports, or simply a pin that
 * went stale all make the number disagree with the binary. Reading the surface
 * asks the question directly, so a below-pin install that has everything this
 * adapter passes keeps working, and an at-pin install that lost a flag is
 * caught before a turn is attempted rather than after.
 *
 * Two different failures come out of here, and they are not interchangeable:
 *
 * - A **missing flag** is fatal for the whole target. Every flag listed below
 *   is on every turn's argv, so there is no configuration that avoids it.
 * - A **missing permission mode** is fatal for the configurations that need
 *   that mode and no others, which is why `permissions.ts` narrows the matrix
 *   with it instead of removing the target.
 *
 * Unknown *extra* flags and modes are ignored on purpose. Claude gains options
 * constantly; treating an unrecognized one as drift would break this feature on
 * every vendor release, which is the exact direction the drift job exists to
 * avoid.
 *
 * The parse itself lives in `@mangostudio/shared/external-agents`, because the
 * vendor-contract capture records the same surface and two parsers would
 * eventually disagree about the same help text.
 */

import {
  parseVendorCliSurface,
  type VendorCliSurface,
  vendorCliBareChoiceList,
  vendorCliQuotedExamples,
} from '@mangostudio/shared/external-agents';

/** The option whose choice list is Claude's permission vocabulary. */
const CLAUDE_PERMISSION_MODE_FLAG = '--permission-mode';

/** The two options whose vocabulary is stated in prose rather than as choices. */
const CLAUDE_MODEL_FLAG = '--model';
const CLAUDE_EFFORT_FLAG = '--effort';

/** Who answers a permission prompt. Declared from 2.1.259; absent before it. */
const CLAUDE_PERMISSION_PROMPTS_FLAG = '--permission-prompts';

/**
 * Long flags `buildTurnArgv` puts on the wire.
 *
 * Every one of these is unconditional except `--model`, which is passed only
 * when a model was chosen — it is still required, because losing it silently
 * removes model selection rather than failing where it could be seen.
 *
 * Short aliases are not listed. `-p` and `--print` are the same option and the
 * adapter passes the long form, so matching the long form is matching what is
 * actually sent.
 */
export const CLAUDE_REQUIRED_CLI_FLAGS: readonly string[] = [
  '--print',
  '--input-format',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--forward-subagent-text',
  CLAUDE_PERMISSION_MODE_FLAG,
  '--resume',
  '--session-id',
  '--model',
];

/** The parsed surface, reduced to the things this adapter reads off it. */
export interface ClaudeCliSurface {
  readonly flags: ReadonlySet<string>;
  /** `--permission-mode`'s own choice list, verbatim. */
  readonly permissionModes: ReadonlySet<string>;
  /**
   * The model aliases `--model`'s description advertises, or absent when it
   * advertises none. Absent is not empty — see `claudeAcceptedModes`.
   */
  readonly modelAliases?: ReadonlySet<string>;
  /** `--effort`'s levels, from the same prose, with the same absent-vs-empty rule. */
  readonly effortLevels?: ReadonlySet<string>;
}

/**
 * Reads `claude --help` into the surface this adapter depends on.
 *
 * Three vocabularies, three shapes the vendor happens to print them in, and
 * none of the shape-reading here: `(choices: …)` for the permission modes, a
 * bare list for the effort levels, a first `(e.g. …)` group for the model
 * aliases. Which flag carries which vocabulary is this adapter's knowledge;
 * how each shape is read is the shared parser's, for the reason its own
 * docblock gives — the vendor-contract capture reads the same help text, and
 * two implementations of prose parsing would eventually disagree about it.
 */
export function parseClaudeCliSurface(help: string): ClaudeCliSurface {
  const surface: VendorCliSurface = parseVendorCliSurface(help, CLAUDE_PERMISSION_MODE_FLAG);
  const modelAliases = vendorCliQuotedExamples(help, CLAUDE_MODEL_FLAG);
  const effortLevels = vendorCliBareChoiceList(help, CLAUDE_EFFORT_FLAG);
  return {
    flags: surface.flags,
    permissionModes: surface.choices,
    ...(modelAliases ? { modelAliases } : {}),
    ...(effortLevels ? { effortLevels } : {}),
  };
}

/**
 * Which required flags this build does not offer, in declaration order.
 *
 * Empty means every argument the adapter passes exists — the answer that lets a
 * below-pin binary keep working.
 */
export function missingClaudeCliFlags(surface: ClaudeCliSurface): readonly string[] {
  return CLAUDE_REQUIRED_CLI_FLAGS.filter((flag) => !surface.flags.has(flag));
}

/**
 * Whether a parsed surface is worth trusting at all.
 *
 * A help text that yielded no permission modes and none of the required flags
 * is far more likely to be a probe that failed — a spawn that produced nothing,
 * a CLI that printed to stderr, a wrapper that swallowed the output — than a
 * build with no options. Treating that as "everything is missing" would make a
 * flaky spawn look like vendor drift and grey out a working install, so callers
 * fall back to the version comparison instead.
 */
export function isUsableClaudeCliSurface(surface: ClaudeCliSurface): boolean {
  return surface.permissionModes.size > 0 || missingClaudeCliFlags(surface).length === 0;
}

/**
 * The modes this build declared, or `undefined` when it declared none.
 *
 * An empty choice list is **unproven**, not "this build accepts no mode", and
 * the two have to stay distinguishable all the way to `claudeModeAccepted` —
 * which reads an absent set as "not established" and keeps the matrix intact,
 * but answers `has()` with `false` for every mode of an empty one.
 *
 * The difference is reachable: a build that offers every required flag and
 * whose `(choices: …)` list moved or wrapped differently parses as usable with
 * no modes, and passing that empty set through as authoritative would grey out
 * every configuration on a binary that can run all of them. Narrowing belongs
 * to a probe that saw the vocabulary, never to one that failed to read it.
 */
export function claudeAcceptedModes(
  surface: ClaudeCliSurface | undefined
): ReadonlySet<string> | undefined {
  return surface && surface.permissionModes.size > 0 ? surface.permissionModes : undefined;
}

/**
 * Whether this build lets the caller say who answers permission prompts.
 *
 * `false` for an unreadable surface, which is the **opposite** default from
 * `claudeModeAccepted`'s, and deliberately so — the two answer different
 * questions. A probe that failed may not *narrow* what the matrix offers, so
 * that one fails open; it also may not *promise* an option exists, so this one
 * fails closed. Passing an undeclared flag is a startup failure on every turn,
 * which is the one outcome worth being pessimistic to avoid.
 */
export function claudeDeclaresPermissionPrompts(surface: ClaudeCliSurface | undefined): boolean {
  return surface?.flags.has(CLAUDE_PERMISSION_PROMPTS_FLAG) ?? false;
}
