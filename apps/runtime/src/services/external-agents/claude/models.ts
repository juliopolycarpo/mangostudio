/**
 * Claude's model catalog, built from the only place the CLI publishes one.
 *
 * There is no `models list` command and no handshake, so the aliases in
 * `--model`'s own description are the whole catalog: the vendor states that
 * `fable`, `opus` and `sonnet` each resolve to the latest model of that family,
 * which is exactly the promise a picker needs. Full model names are accepted by
 * the flag too, but they are not advertised — the help offers one as an
 * *example* of the other form, and an account that lacks it gets a failed turn.
 *
 * The effort levels ride on every entry rather than on the session. `--effort`
 * is session-scoped in the CLI, so every model accepts the same list; carrying
 * it per model is what the neutral contract's shape asks for and costs nothing
 * to keep true.
 *
 * **Nothing is marked default, and that is deliberate.** The help declares no
 * default model and no default effort. A catalog that named one would make
 * `pickModel` resolve it for a chat that chose nothing, put `--model` on every
 * argv, and quietly override whatever default the account itself is on —
 * turning a display concern into a behaviour change. With no default, an
 * unchosen model resolves to nothing, no flag is passed, and the vendor decides.
 */

import type {
  ExternalAgentModel,
  ExternalAgentReasoningEffort,
} from '@mangostudio/shared/external-agents';
import type { ClaudeCliSurface } from './cli-surface';

/**
 * The catalog this build advertises, or `undefined` when it advertises none.
 *
 * Absent rather than empty, and the two are not interchangeable: `undefined`
 * leaves `modelCatalog` false and the composer's picker hidden, which is what a
 * build predating the alias prose should do. An empty catalog would be a picker
 * that offers nothing.
 *
 * @example
 * claudeModelCatalog(parseClaudeCliSurface(help));
 * // [{ id: 'fable', supportedReasoningEfforts: [{ id: 'low' }, …] }, …]
 */
export function claudeModelCatalog(
  surface: ClaudeCliSurface | undefined
): readonly ExternalAgentModel[] | undefined {
  const aliases = surface?.modelAliases;
  if (!aliases || aliases.size === 0) return undefined;
  const efforts = reasoningEfforts(surface?.effortLevels);
  return [...aliases].map((alias) => ({
    id: alias,
    ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
  }));
}

/**
 * The effort levels as the neutral contract's own shape.
 *
 * No `displayName`: the vendor prints bare identifiers and nothing else, and a
 * prettier label invented here would be MangoStudio text wearing the vendor's
 * name in a control that describes the vendor's behaviour.
 */
function reasoningEfforts(
  levels: ReadonlySet<string> | undefined
): readonly ExternalAgentReasoningEffort[] | undefined {
  if (!levels || levels.size === 0) return undefined;
  return [...levels].map((id) => ({ id }));
}

/**
 * Whether this build declared the effort level a configuration asked for.
 *
 * The same "drop what the binary did not declare" rule `safeClaudeModel`
 * applies, and for a stronger reason: a stored chat configuration outlives the
 * install that produced it, and an unrecognized value on a command line is read
 * by the CLI's parser as a new flag rather than as `--effort`'s value. Deciding
 * by membership in the parsed set means only a string the vendor itself printed
 * can ever be passed.
 */
export function claudeEffortAccepted(
  effort: string | undefined,
  accepted: ReadonlySet<string> | undefined
): effort is string {
  return effort !== undefined && accepted?.has(effort) === true;
}
