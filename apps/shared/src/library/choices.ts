import Type, { type Static } from 'typebox';

export const ResourceKindSchema = Type.Union([
  Type.Literal('skill'),
  Type.Literal('subagent'),
  Type.Literal('command'),
  Type.Literal('instruction'),
  Type.Literal('setting'),
  Type.Literal('hook'),
]);

export const LIBRARY_RESOURCE_SLUG_MAX_LENGTH = 128;

/**
 * Path-safe shape a library resource slug must satisfy: dot-separated groups of
 * `[A-Za-z0-9_-]`. Rejects separators, `..`, leading/trailing dots, drive/stream
 * colons, whitespace and control characters, so a slug is always safe to use as
 * a single directory name or file stem.
 */
export const LIBRARY_RESOURCE_SLUG_PATTERN = '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$';

export type ResourceKind = Static<typeof ResourceKindSchema>;

export const LibraryTargetIdSchema = Type.Union([
  Type.Literal('mangostudio'),
  Type.Literal('claude'),
  Type.Literal('codex'),
  Type.Literal('cursor'),
]);

/** Stable id of one code-defined library location. */
export const LibraryLocationIdSchema = Type.String({ minLength: 1, maxLength: 64 });

/**
 * Where a location is rooted. `home` resolves under the user's home directory.
 * `workspace` resolves under a repository root and is **reserved**: v1 defines
 * no workspace-scoped location, so nothing resolves under it yet.
 *
 * Scope is a field rather than a fork of the id space on purpose. The same
 * logical location exists at both scopes — `.claude/skills` under `~` and under
 * a repository are one concept read from two roots — so ids stay scope-free and
 * every map keyed on them stays one map.
 *
 * If no workspace location exists when this stops earning its keep, delete the
 * seam rather than leaving it as decoration.
 */
export const LibraryScopeSchema = Type.Union([Type.Literal('home'), Type.Literal('workspace')]);

/**
 * Runtime companion to `LibraryScopeSchema`. Iterating scopes is a normal need
 * — nesting settings, building per-scope caches — and re-deriving the list from
 * the schema at every call site is how one of them ends up out of date.
 */
export const LIBRARY_SCOPES = ['home', 'workspace'] as const;

export type LibraryTargetId = Static<typeof LibraryTargetIdSchema>;

export type LibraryLocationId = Static<typeof LibraryLocationIdSchema>;

export type LibraryScope = Static<typeof LibraryScopeSchema>;

/** Every resource kind, derived from the canonical wire schema. */
export const RESOURCE_KINDS: readonly ResourceKind[] = ResourceKindSchema.anyOf.map(
  (member) => member.const
);

/**
 * Whether an untrusted value is a supported resource kind, without coercion.
 * @example
 * isResourceKind('skill'); // true
 * isResourceKind('toString'); // false
 */
export function isResourceKind(value: unknown): value is ResourceKind {
  return RESOURCE_KINDS.some((kind) => kind === value);
}
