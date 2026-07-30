import { type Static, Type } from '@sinclair/typebox';

/** Kinds a subject key can name; each mirrors an existing schema family. */
const ToolIdentityKindSchema = Type.Union([
  Type.Literal('agent'),
  Type.Literal('runtime'),
  Type.Literal('version-manager'),
  Type.Literal('mcp'),
]);
export type ToolIdentityKind = Static<typeof ToolIdentityKindSchema>;

export const TOOL_IDENTITY_DISPLAY_NAME_MAX_LENGTH = 64;

/**
 * `<kind>:<id>`. The id half is the wire id the rest of the system already uses
 * — a runtime id, a library target id, a version manager id, or an MCP slug —
 * and it never renames: an identity is a label hung on an id, not a new id.
 *
 * The grammar is all this pattern can prove. That an id is a member of its
 * kind's closed union, and that an MCP slug belongs to the caller, is checked
 * in code (`parseSubjectKey`, and the API's own ownership check).
 */
export const SubjectKeySchema = Type.String({
  minLength: 5,
  maxLength: 80,
  pattern: '^(agent|runtime|version-manager|mcp):[a-z0-9]+(?:-[a-z0-9]+)*$',
});
export type SubjectKey = Static<typeof SubjectKeySchema>;

/**
 * A name the user typed. Trimmed before it is stored, so the stored value never
 * carries padding; control characters are refused outright because a name is
 * rendered in headers, menus, and dialogs where they have no meaning.
 */
const ToolDisplayNameSchema = Type.String({
  minLength: 1,
  maxLength: TOOL_IDENTITY_DISPLAY_NAME_MAX_LENGTH,
  pattern: '^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$',
});

/**
 * One or two characters drawn on the avatar, stored uppercased.
 *
 * Written as an exclusion rather than `\p{L}\p{N}`: TypeBox compiles patterns
 * without the `u` flag, so unicode property escapes never match. Excluding
 * whitespace, control characters, and ASCII punctuation keeps the intent
 * (letters and digits) without locking non-Latin scripts out of their own
 * initials.
 */
const ToolMonogramSchema = Type.String({
  pattern: '^[^\\s\\x00-\\x1f\\x7f!-/:-@\\[-`{-~]{1,2}$',
});

/**
 * One stored override. Both fields are nullable and independent: a user can
 * rename without touching the monogram, and clearing either one falls back to
 * the derived default rather than to blank.
 */
export const ToolIdentitySchema = Type.Object(
  {
    subjectKey: SubjectKeySchema,
    displayName: Type.Union([ToolDisplayNameSchema, Type.Null()]),
    monogram: Type.Union([ToolMonogramSchema, Type.Null()]),
    updatedAt: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);
export type ToolIdentity = Static<typeof ToolIdentitySchema>;

/** Absent field: leave as stored. Explicit `null`: reset that field to default. */
export const ToolIdentityUpdateSchema = Type.Object(
  {
    displayName: Type.Optional(Type.Union([ToolDisplayNameSchema, Type.Null()])),
    monogram: Type.Optional(Type.Union([ToolMonogramSchema, Type.Null()])),
  },
  { additionalProperties: false }
);
export type ToolIdentityUpdate = Static<typeof ToolIdentityUpdateSchema>;

/**
 * Only subjects the user has actually customized appear. Everything else
 * resolves to its derived default with no row and no request.
 */
const ToolIdentityMapSchema = Type.Record(Type.String(), ToolIdentitySchema);
export type ToolIdentityMap = Static<typeof ToolIdentityMapSchema>;

export const ToolIdentityListResponseSchema = Type.Object(
  { identities: ToolIdentityMapSchema },
  { additionalProperties: false }
);
export type ToolIdentityListResponse = Static<typeof ToolIdentityListResponseSchema>;

/**
 * What is stored after the write. `null` means the update resolved back to the
 * derived default, so the client drops the entry rather than caching a row of
 * nulls — the same state a reset leaves behind.
 */
export const ToolIdentityUpdateResponseSchema = Type.Object(
  { identity: Type.Union([ToolIdentitySchema, Type.Null()]) },
  { additionalProperties: false }
);
export type ToolIdentityUpdateResponse = Static<typeof ToolIdentityUpdateResponseSchema>;
