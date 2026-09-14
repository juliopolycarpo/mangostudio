/**
 * What a settings or hook source looks like once the machine that holds it has
 * opened it, before anybody parses it.
 *
 * Shared because the reading and the parsing live on opposite sides: the
 * runtime opens the files, and the hub parses, redacts and compares the bytes.
 * The runtime contract declares them as the result of `library.settings-sources`,
 * so declaring them once keeps the reader and the parsers from drifting.
 *
 * Schema-first — nothing here opens a file.
 */

import Type, { type Static } from 'typebox';
import { ReadonlyArraySchema } from '../schema-helpers';
import { LibraryLocationIdSchema } from './schemas';

/** Why a source that exists could not be turned into settings text. */
export const RuntimeSettingsReadFailureSchema = Type.Union([
  Type.Literal('unreadable'),
  Type.Literal('not-regular-file'),
  Type.Literal('too-large'),
]);
export type RuntimeSettingsReadFailure = Static<typeof RuntimeSettingsReadFailureSchema>;

/** One `.rules` file of a `rules-dsl` location. */
export const RuntimeSettingsRuleFileSchema = Type.Object({
  name: Type.String(),
  content: Type.String(),
});
export type RuntimeSettingsRuleFile = Static<typeof RuntimeSettingsRuleFileSchema>;

export const RuntimeSettingsSourceSchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  /**
   * False when the location does not resolve on this machine or nothing is
   * there. A missing settings file is an ordinary state, not a failure.
   */
  present: Type.Boolean(),
  sizeBytes: Type.Optional(Type.Number()),
  failureReason: Type.Optional(RuntimeSettingsReadFailureSchema),
  /** Raw text, for every format except `rules-dsl`. */
  content: Type.Optional(Type.String()),
  /** One entry per `.rules` file, name-sorted, for `rules-dsl` locations. */
  rules: Type.Optional(ReadonlyArraySchema(RuntimeSettingsRuleFileSchema)),
});
export type RuntimeSettingsSource = Static<typeof RuntimeSettingsSourceSchema>;

export const RuntimeSettingsSourcesResultSchema = Type.Object({
  /**
   * This machine's home directory. The hub's parsers abbreviate paths against
   * it, and abbreviating a remote path against the hub's home would be wrong.
   */
  homeDir: Type.String(),
  sources: ReadonlyArraySchema(RuntimeSettingsSourceSchema),
});
export type RuntimeSettingsSourcesResult = Static<typeof RuntimeSettingsSourcesResultSchema>;
