/**
 * The slash commands the composer acts on itself (issue #2599).
 *
 * A library command is a template the hub expands into the model's prompt. These
 * are the opposite: they change the chat or the composer, so they never reach
 * the model. The names are shared because both ends must agree on them — the
 * composer runs them, and the hub must never expand a user's file of the same
 * name over one, the way the vendors' CLIs refuse to let a file shadow a
 * built-in.
 */

export const BUILT_IN_SLASH_COMMANDS = ['clear', 'model'] as const;

export type BuiltInSlashCommandName = (typeof BUILT_IN_SLASH_COMMANDS)[number];

export interface BuiltInSlashInvocation {
  readonly name: BuiltInSlashCommandName;
  /** Everything after the name, trimmed. */
  readonly args: string;
}

/**
 * Whether `name` is a built-in. Exact match: `/clearance` is not `/clear`.
 * // Usage: isBuiltInSlashCommand('clear') === true
 */
export function isBuiltInSlashCommand(name: string): name is BuiltInSlashCommandName {
  return (BUILT_IN_SLASH_COMMANDS as readonly string[]).includes(name);
}

/**
 * The built-in a whole prompt invokes, or `null` when it is ordinary text.
 *
 * Only a leading slash counts, like every other command, and a first token with
 * a second slash is a path rather than a name.
 * // Usage: parseBuiltInSlashInvocation('/model fast') // { name: 'model', args: 'fast' }
 */
export function parseBuiltInSlashInvocation(prompt: string): BuiltInSlashInvocation | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  const name = match?.[1];
  if (name === undefined || !isBuiltInSlashCommand(name)) return null;
  return { name, args: (match?.[2] ?? '').trim() };
}
