/**
 * Identity resolution: what a tool is called and what its avatar says.
 *
 * Deliberately React-free and dependency-light so the fallback chain — custom
 * name, then product name, then raw id — can be asserted directly. Nothing here
 * reaches a wire id: a resolved identity is what a human reads, and the subject
 * key it carries is the id everything else keeps using.
 */

import type { ToolIdentity, ToolIdentityMap } from '@mangostudio/shared/tool-identity';

export interface ResolvedToolIdentity {
  readonly subjectKey: string;
  /** Custom name if the user set one, else the product name for the id. */
  readonly name: string;
  /** One or two characters, uppercased; derived from `name` unless overridden. */
  readonly monogram: string;
  /**
   * The stored overrides themselves, per field.
   *
   * An editor cannot infer these from `name`/`monogram`: a monogram stored as
   * "CC" is indistinguishable from one derived from "Claude Code", and a form
   * that guesses would drop the saved value the next time the tool is renamed.
   */
  readonly storedName: string | null;
  readonly storedMonogram: string | null;
  /** Whether either field is a stored override — drives the Reset affordance. */
  readonly customized: boolean;
}

/** Placeholder for the impossible case of a subject with no readable name. */
const EMPTY_MONOGRAM = '?';

/**
 * First letters of the first two words, else the first two characters.
 *
 * Split by code point rather than by UTF-16 unit so an emoji or an astral
 * character contributes one character instead of half of one. Uppercasing can
 * lengthen a string ("ß" → "SS"), so the result is re-trimmed afterwards.
 */
export function deriveMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return EMPTY_MONOGRAM;

  const source =
    words.length > 1
      ? `${firstCharacter(words[0])}${firstCharacter(words[1])}`
      : takeCharacters(words[0], 2);

  const monogram = takeCharacters(source.toUpperCase(), 2);
  return monogram.length > 0 ? monogram : EMPTY_MONOGRAM;
}

function firstCharacter(word: string): string {
  return takeCharacters(word, 1);
}

function takeCharacters(value: string, count: number): string {
  return Array.from(value).slice(0, count).join('');
}

/**
 * Resolves one subject against the stored overrides.
 *
 * `fallbackName` is the product name the caller already knows how to compute
 * (`format.ts#displayName`), which keeps the i18n dictionary out of this module
 * and keeps the existing "unknown id degrades to the raw id" rule intact.
 */
export function resolveToolIdentity(
  identities: ToolIdentityMap,
  subjectKey: string,
  fallbackName: string
): ResolvedToolIdentity {
  const stored: ToolIdentity | undefined = identities[subjectKey];
  const name = stored?.displayName ?? fallbackName;

  return {
    subjectKey,
    name,
    // A monogram override survives a rename; without one the monogram tracks
    // whatever the tool is currently called.
    monogram: stored?.monogram ?? deriveMonogram(name),
    storedName: stored?.displayName ?? null,
    storedMonogram: stored?.monogram ?? null,
    customized: Boolean(stored),
  };
}
