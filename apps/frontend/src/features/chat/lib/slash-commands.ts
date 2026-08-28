/**
 * The composer's `/` palette, as pure functions.
 *
 * Two rules shape all of it, and both come from what the CLIs actually do:
 *
 * 1. **Only a leading slash is a command.** Claude Code and Cursor expand
 *    `/name` at the head of a message and treat it as ordinary text anywhere
 *    else. Opening a palette mid-sentence would offer a completion that inserts
 *    something the agent will not act on.
 * 2. **The catalog is a hint, not an allowlist.** A command file written after
 *    a Cursor session opened still expands when typed, but never appears in
 *    that session's announced list. Nothing here refuses a name it has not
 *    seen; the palette only helps the user find one.
 *
 * No React, so the ranking and the caret arithmetic can be tested without
 * rendering a composer.
 */

export interface SlashCommandEntry {
  /** Invoked as `/name`. */
  readonly name: string;
  readonly description?: string;
  /** Where the name came from, which is what the palette's secondary label says. */
  readonly origin: 'session' | 'library' | 'skill';
}

/** How many rows the palette will show at once. */
const RESULT_LIMIT = 12;

/**
 * The partial command the caret is sitting in, or `null` when the composer is
 * not in a command position.
 *
 * `/` on its own returns `''` — an empty query that matches everything, which
 * is what makes the bare slash open a full list.
 * // Usage: slashQueryAt('/rev', 4) === 'rev'
 */
export function slashQueryAt(value: string, caret: number): string | null {
  if (!value.startsWith('/')) return null;
  const whitespace = value.slice(1).search(/\s/);
  const tokenEnd = whitespace === -1 ? value.length : whitespace + 1;
  // The caret has to be inside the command token itself. Past the first space
  // the user is writing arguments, and a palette over those would replace the
  // command they already chose.
  if (caret < 1 || caret > tokenEnd) return null;

  const query = value.slice(1, tokenEnd);
  // An absolute path is the common first token in this product — "/home/me/repo
  // is broken" — and no vendor's command name has ever contained a separator:
  // Claude Code namespaces plugin commands with `:`, Cursor uses plain names.
  // Without this the palette sits open over every path the user types.
  return query.includes('/') ? null : query;
}

/** A completed prompt and where the caret belongs in it. */
export interface SlashCompletion {
  readonly value: string;
  readonly caret: number;
}

/**
 * Replaces the command token with `name`, keeping whatever arguments follow.
 *
 * A completed command always ends in a space when nothing follows it, because
 * every one of these takes arguments and the next thing the user types is one.
 * The caret comes back with the text rather than from a second function: it is
 * a position *in this string*, and deriving it from the name alone is how it
 * ends up inside a separator the completion did not write — a newline, or the
 * second of two spaces.
 * // Usage: applySlashCompletion('/rev --all', 'review') === { value: '/review --all', caret: 8 }
 */
export function applySlashCompletion(value: string, name: string): SlashCompletion {
  const whitespace = value.slice(1).search(/\s/);
  const completed = `/${name}`;
  const next = whitespace === -1 ? ' ' : value.slice(whitespace + 1);
  // Past the name, and past the separator when it is a single space, so the
  // next keystroke is an argument. A newline or a run of spaces is the user's
  // own formatting and stays in front of the caret.
  const skipsSeparator = next.startsWith(' ') && !next.startsWith('  ');
  return {
    value: `${completed}${next}`,
    caret: completed.length + (skipsSeparator ? 1 : 0),
  };
}

/**
 * Merges the sources into one list, best-known name first.
 *
 * The vendor's own catalog wins a name outright: when Cursor says it loaded
 * `review`, its description is what that session will run, and a library row
 * for the same slug is the same command seen from the outside. Sources are
 * therefore layered rather than concatenated — otherwise every command that
 * propagated correctly would appear twice, which is precisely the case the
 * library exists to produce.
 * // Usage: mergeSlashCommands([session], [library], [skills])
 */
export function mergeSlashCommands(
  ...sources: ReadonlyArray<readonly SlashCommandEntry[]>
): readonly SlashCommandEntry[] {
  const merged: SlashCommandEntry[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const entry of source) {
      const name = entry.name.trim();
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      merged.push({ ...entry, name });
    }
  }
  return merged;
}

/**
 * The closest matches for what the user has typed, best first.
 *
 * Ranked in four tiers rather than scored: the name typed in full is the one
 * the user meant, a prefix match is what someone typing a name they already
 * know is doing, a name that merely contains the query is the next most likely,
 * and a description match is how a command gets found by what it does. Ties
 * keep the order the sources were merged in, so the vendor's live list stays
 * ahead of the library's scan.
 *
 * The exact tier is load-bearing rather than a nicety: catalogs arrive in the
 * vendor's own order, so `['test-all', 'test']` would otherwise put `test-all`
 * first for the query `test` and Enter would rewrite the command the user had
 * already finished typing into a different one.
 * // Usage: matchSlashCommands(entries, 'rev')
 */
export function matchSlashCommands(
  entries: readonly SlashCommandEntry[],
  query: string,
  limit: number = RESULT_LIMIT
): readonly SlashCommandEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries.slice(0, limit);

  const exact: SlashCommandEntry[] = [];
  const prefix: SlashCommandEntry[] = [];
  const infix: SlashCommandEntry[] = [];
  const described: SlashCommandEntry[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (name === needle) {
      exact.push(entry);
      continue;
    }
    if (name.startsWith(needle)) {
      prefix.push(entry);
      continue;
    }
    if (name.includes(needle)) {
      infix.push(entry);
      continue;
    }
    if (entry.description?.toLowerCase().includes(needle)) described.push(entry);
  }
  return [...exact, ...prefix, ...infix, ...described].slice(0, limit);
}

/** Moves the highlight, wrapping at both ends so the list is a loop. */
export function nextSlashIndex(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return 0;
  return (current + step + count) % count;
}
