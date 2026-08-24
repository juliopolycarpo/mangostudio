/**
 * The palette's ranking, kept pure.
 *
 * No fuzzy library: the whole need is a few hundred rows and a query the user
 * is still typing, and a dependency for that would bring its own scoring model
 * to argue with. What matters here is that the order is *explainable* — an
 * exact title beats a prefix, a prefix beats a word start, a word start beats a
 * substring, and a scattered subsequence comes last — and that it never
 * reshuffles the section headings underneath the reader.
 */

import { COMMAND_SECTIONS, type CommandItem, type CommandSection } from './command-item';

/**
 * Each tier is a thousand apart so a positional penalty inside one can never
 * reach into the next: a late substring stays above the best subsequence.
 */
const TIER = {
  exact: 5000,
  prefix: 4000,
  wordPrefix: 3000,
  substring: 2000,
  subsequence: 1000,
} as const;

/** Keeps every penalty inside its own tier. */
const MAX_PENALTY = 999;

/**
 * Demotes a keyword hit below every label hit. Larger than the best possible
 * score, so the two ranges cannot overlap however the tiers are tuned.
 */
const KEYWORD_DEMOTION = TIER.exact + 1;

const WORD_BOUNDARY = /[\s/\-_.:·—]/;

/**
 * Accent-insensitive lower case. pt-BR is a first-class locale here, and a
 * palette where "sessao" does not find "sessão" is one that only works for
 * whoever typed the title.
 */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function clampPenalty(value: number): number {
  return Math.min(Math.max(value, 0), MAX_PENALTY);
}

/**
 * Where `needle` starts a word inside `haystack`, or -1. Both are already
 * normalized.
 */
function wordPrefixIndex(haystack: string, needle: string): number {
  let index = haystack.indexOf(needle);
  while (index > 0) {
    if (WORD_BOUNDARY.test(haystack[index - 1])) return index;
    index = haystack.indexOf(needle, index + 1);
  }
  return -1;
}

/**
 * The tightest run of `haystack` containing `needle`'s characters in order, or
 * null. Tightness is what separates "cmdp" matching `command palette` from the
 * same letters scattered across a paragraph.
 */
function subsequenceSpan(haystack: string, needle: string): number | null {
  let cursor = 0;
  let start = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    if (start === -1) start = found;
    cursor = found + 1;
  }
  return cursor - start;
}

/**
 * How well `text` answers `query`, or null when it does not at all. An empty
 * query matches everything at the same score, which is what leaves the caller's
 * own order (recency, for sessions) intact.
 */
export function matchScore(text: string, query: string): number | null {
  const needle = normalize(query.trim());
  if (needle.length === 0) return 0;
  const haystack = normalize(text);

  if (haystack === needle) return TIER.exact;
  // Shorter labels win the tie: "Git" before "Git commit messages" for `git`.
  if (haystack.startsWith(needle)) {
    return TIER.prefix - clampPenalty(haystack.length - needle.length);
  }

  const wordIndex = wordPrefixIndex(haystack, needle);
  if (wordIndex > 0) return TIER.wordPrefix - clampPenalty(wordIndex);

  const substringIndex = haystack.indexOf(needle);
  if (substringIndex >= 0) return TIER.substring - clampPenalty(substringIndex);

  const span = subsequenceSpan(haystack, needle);
  if (span === null) return null;
  return TIER.subsequence - clampPenalty(span - needle.length);
}

/**
 * A row's score: its label first, then everything else it can be found by — the
 * hint it renders, and whatever the provider made searchable without rendering.
 *
 * The second haystack is newline-joined so no query can match across the seam
 * between two of its parts; a search box cannot produce a newline.
 */
export function scoreCommand(item: CommandItem, query: string): number | null {
  const direct = matchScore(item.label, query);
  if (direct !== null) return direct;

  const secondary = [item.hint, item.keywords].filter(Boolean).join('\n');
  if (secondary.length === 0) return null;
  const indirect = matchScore(secondary, query);
  return indirect === null ? null : indirect - KEYWORD_DEMOTION;
}

interface CommandGroup {
  readonly section: CommandSection;
  readonly items: readonly CommandItem[];
}

export interface RankedCommands {
  readonly groups: readonly CommandGroup[];
  /** Flattened reading order — what ↑↓ walks and what `bestIndex` points into. */
  readonly flat: readonly CommandItem[];
  /**
   * Where the selection should start: the best-scoring row anywhere, not the
   * first row of the first section.
   *
   * The two come apart constantly, because the sections are deliberately in a
   * fixed order. Type "git" and a session that merely contains those letters
   * sits above an exact settings tab — highlighting it would make Enter open
   * the wrong thing while the right one is on screen. -1 when nothing matched.
   */
  readonly bestIndex: number;
}

export interface RankOptions {
  /**
   * How many sessions an empty query shows. The full list is what the sidebar
   * is for; the palette opens on the handful you were just in.
   */
  readonly recentSessionLimit?: number;
}

const DEFAULT_RECENT_SESSION_LIMIT = 6;

/**
 * Groups and orders the registry for one query.
 *
 * Sections keep their declared order and empty ones are dropped. Inside a
 * section rows go by score, ties broken by the order the provider returned them
 * in — which is recency for sessions and a deliberate reading order everywhere
 * else, so the result is stable rather than merely sorted.
 */
export function rankCommands(
  items: readonly CommandItem[],
  query: string,
  options: RankOptions = {}
): RankedCommands {
  const { recentSessionLimit = DEFAULT_RECENT_SESSION_LIMIT } = options;
  const searching = query.trim().length > 0;

  const scored: Array<{ item: CommandItem; score: number; index: number }> = [];
  for (const [index, item] of items.entries()) {
    const score = scoreCommand(item, query);
    if (score === null) continue;
    scored.push({ item, score, index });
  }
  const byItem = new Map(scored.map((entry) => [entry.item, entry.score]));

  const groups = COMMAND_SECTIONS.flatMap<CommandGroup>((section) => {
    const inSection = scored
      .filter((entry) => entry.item.section === section)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((entry) => entry.item);
    // Only the resting state is capped. Once a query is typed, hiding matches
    // behind a number nobody was shown is how a palette starts lying about what
    // it holds.
    const visible =
      !searching && section === 'sessions' ? inSection.slice(0, recentSessionLimit) : inSection;
    return visible.length > 0 ? [{ section, items: visible }] : [];
  });

  const flat = groups.flatMap((group) => group.items);
  // With no query every score is equal, so this is the first recent session —
  // which is the row the palette should open on anyway.
  let bestIndex = flat.length > 0 ? 0 : -1;
  for (const [index, item] of flat.entries()) {
    if ((byItem.get(item) ?? 0) > (byItem.get(flat[bestIndex]) ?? 0)) bestIndex = index;
  }

  return { groups, flat, bestIndex };
}

/**
 * Where the cursor sits in a ranking, given whatever the user pinned it to.
 *
 * `null` means "wherever the ranking says", which is how a fresh query lands on
 * the best match anywhere rather than on the first row of the first section.
 *
 * The pin is a command id, not an offset: the list can change under a held
 * cursor without a keystroke — discovery finishing inserts runner rows above
 * everything below them — and a numeric pin would silently slide onto a
 * different command, so the row Enter runs would not be the row the user chose.
 * A pinned id the ranking no longer contains releases back to the best match,
 * which also covers a query narrowed past the pinned row. -1 when nothing
 * matched.
 *
 * Shared by the render and by Enter so the two cannot disagree about which row
 * is armed — which is the entire failure mode this is guarding.
 */
export function activeCommandIndex(ranked: RankedCommands, activeId: string | null): number {
  if (ranked.flat.length === 0) return -1;
  if (activeId !== null) {
    const pinned = ranked.flat.findIndex((item) => item.id === activeId);
    if (pinned >= 0) return pinned;
  }
  return ranked.bestIndex;
}
