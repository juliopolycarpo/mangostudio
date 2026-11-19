/**
 * Identity resolution: what a tool is called and what its avatar says.
 *
 * Deliberately React-free and dependency-light so the fallback chain — custom
 * name, then product name, then raw id — can be asserted directly. Nothing here
 * reaches a wire id: a resolved identity is what a human reads, and the subject
 * key it carries is the id everything else keeps using.
 */

import type { ToolIdentity, ToolIdentityMap, ToolImage } from '@mangostudio/shared/tool-identity';

import type { ToolImageDisplay } from '@/components/ui/ToolAvatar';

import { toolImageDisplay } from './image';

export interface ResolvedToolIdentity {
  readonly subjectKey: string;
  /** Custom name if the user set one, else the product name for the id. */
  readonly name: string;
  /** One or two characters, uppercased; derived from `name` unless overridden. */
  readonly monogram: string;
  /** Where the avatar's pixels come from, or null to draw the monogram. */
  readonly image: ToolImageDisplay | null;
  /**
   * The stored overrides themselves, per field.
   *
   * An editor cannot infer these from `name`/`monogram`: a monogram stored as
   * "CC" is indistinguishable from one derived from "Claude Code", and a form
   * that guesses would drop the saved value the next time the tool is renamed.
   */
  readonly storedName: string | null;
  readonly storedMonogram: string | null;
  /** The stored image itself, so the editor can seed its own fields from it. */
  readonly storedImage: ToolImage | null;
  /** Whether any field is a stored override — drives the Reset affordance. */
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
 * Whether the registry may rename this subject.
 *
 * An MCP server already has a name the user chose and edits in its own form,
 * and that name travels with exports and imports; a second, registry-side name
 * would put two renames on one card. Its identity keeps the avatar fields only.
 */
export function isIdentityNameEditable(subjectKey: string): boolean {
  return !subjectKey.startsWith('mcp:');
}

/**
 * Resolves one subject against the stored overrides.
 *
 * `fallbackName` is the product name the caller already knows how to compute
 * (`format.ts#displayName`), which keeps the i18n dictionary out of this module
 * and keeps the existing "unknown id degrades to the raw id" rule intact.
 *
 * For a subject whose name is not editable here, a display name stored before
 * that rule existed is ignored on read, not cleared: no data is rewritten, and
 * every surface that resolves the subject agrees with the card. The stored
 * name is reported as absent so the editor never sends a patch that clears it
 * as a side effect of saving the monogram or image.
 */
export function resolveToolIdentity(
  identities: ToolIdentityMap,
  subjectKey: string,
  fallbackName: string
): ResolvedToolIdentity {
  const stored: ToolIdentity | undefined = identities[subjectKey];
  const storedName = isIdentityNameEditable(subjectKey) ? (stored?.displayName ?? null) : null;
  const name = storedName ?? fallbackName;

  return {
    subjectKey,
    name,
    // A monogram override survives a rename; without one the monogram tracks
    // whatever the tool is currently called.
    monogram: stored?.monogram ?? deriveMonogram(name),
    image: toolImageDisplay(subjectKey, stored?.image ?? null, stored?.updatedAt ?? 0),
    storedName,
    storedMonogram: stored?.monogram ?? null,
    storedImage: stored?.image ?? null,
    customized: Boolean(stored),
  };
}
