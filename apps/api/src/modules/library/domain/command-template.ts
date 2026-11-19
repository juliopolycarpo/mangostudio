/**
 * Pure rules for a MangoStudio slash command: recognising `/name args` at the
 * head of a prompt and expanding a command file's body with those arguments.
 *
 * The placeholders are the intersection Claude Code and Codex both document for
 * a command file — `$ARGUMENTS` and `$1`..`$9` — so a file that propagated from
 * either vendor's directory expands the way its author wrote it. A template
 * that names no placeholder still receives its arguments, appended the way
 * Claude Code does, because dropping what the user typed after the name would
 * be the worse failure.
 */

export interface SlashInvocation {
  readonly name: string;
  /** Everything after the name, trimmed. Newlines inside it are the user's. */
  readonly args: string;
}

/**
 * The command a prompt invokes, or `null` when it is not in command position.
 *
 * Only a leading slash counts, matching the composer's palette. A first token
 * containing a second slash is a path ("/home/me/repo is broken"), never a
 * command name, so it is never looked up.
 * // Usage: parseSlashInvocation('/review a.ts') // { name: 'review', args: 'a.ts' }
 */
export function parseSlashInvocation(prompt: string): SlashInvocation | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match?.[1]) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

/**
 * Splits an argument string into positional arguments, honouring single and
 * double quotes so `"two words"` stays one argument.
 * // Usage: splitCommandArguments('a "b c"') // ['a', 'b c']
 */
export function splitCommandArguments(args: string): string[] {
  const tokens: string[] = [];
  for (const match of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/** `$ARGUMENTS` or a single-digit position; `$10` reads as `$1` followed by `0`. */
const PLACEHOLDER = /\$(ARGUMENTS|[1-9])/g;

/**
 * Expands a command body (frontmatter already stripped) with the user's arguments.
 *
 * Substitution is one pass over the template, so an argument that itself
 * contains `$1` is inserted as text rather than expanded a second time.
 * // Usage: expandCommandTemplate('Review $1', 'a.ts') // 'Review a.ts'
 */
export function expandCommandTemplate(body: string, args: string): string {
  const template = body.trim();
  const positional = splitCommandArguments(args);
  let usedPlaceholder = false;
  const expanded = template.replace(PLACEHOLDER, (_match, token: string) => {
    usedPlaceholder = true;
    return token === 'ARGUMENTS' ? args : (positional[Number(token) - 1] ?? '');
  });
  if (usedPlaceholder || args.length === 0) return expanded;
  return `${expanded}\n\nARGUMENTS: ${args}`;
}
