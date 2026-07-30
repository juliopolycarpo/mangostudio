/**
 * Subject keys: the join between an identity row and the tool it labels.
 *
 * The id half of every key is a wire id that already exists elsewhere in the
 * contract, so membership is checked against those schemas rather than against
 * a second list that could drift away from them.
 */

import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { RuntimeIdSchema, VersionManagerIdSchema } from '../environments';
import { LibraryTargetIdSchema } from '../library';
import { SubjectKeySchema, type ToolIdentityKind } from './schemas';

/** Kinds whose ids come from a closed union and can be validated offline. */
type StaticToolIdentityKind = Exclude<ToolIdentityKind, 'mcp'>;

const STATIC_KIND_ID_SCHEMAS = {
  agent: LibraryTargetIdSchema,
  runtime: RuntimeIdSchema,
  'version-manager': VersionManagerIdSchema,
} as const satisfies Record<StaticToolIdentityKind, TSchema>;

export interface ParsedSubjectKey {
  readonly kind: ToolIdentityKind;
  /** Wire id for a static kind; the server slug for `mcp`. */
  readonly id: string;
}

/**
 * Splits a subject key and rejects anything whose grammar or membership is
 * wrong. `mcp` keys pass on grammar alone — only the API knows which slugs
 * exist, and it checks ownership at write time.
 */
export function parseSubjectKey(subjectKey: string): ParsedSubjectKey | undefined {
  if (!Value.Check(SubjectKeySchema, subjectKey)) return undefined;

  const separatorIndex = subjectKey.indexOf(':');
  const kind = subjectKey.slice(0, separatorIndex) as ToolIdentityKind;
  const id = subjectKey.slice(separatorIndex + 1);

  if (kind === 'mcp') return { kind, id };
  return Value.Check(STATIC_KIND_ID_SCHEMAS[kind], id) ? { kind, id } : undefined;
}

/**
 * Builds the key for a tool the caller already holds a typed id for. Callers
 * with a typed id cannot produce an invalid key, so this returns a plain string
 * rather than a result to unwrap.
 */
export function toolSubjectKey(kind: ToolIdentityKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Uppercases a monogram and caps it at two characters.
 *
 * The cap has to survive the uppercasing rather than precede it: a ligature
 * grows when uppercased ("ﬃ" → "FFI"), so a value that satisfied the schema on
 * the way in can violate it on the way out — and a stored monogram that fails
 * its own response schema turns every later read into a 500. Slicing by code
 * point keeps an astral character whole instead of storing half a pair.
 *
 * Shared because storing and previewing must agree; a preview that shows
 * something the server will not store is a lie the user only discovers on save.
 */
export function normalizeMonogram(value: string): string {
  return Array.from(value.toUpperCase()).slice(0, 2).join('');
}
