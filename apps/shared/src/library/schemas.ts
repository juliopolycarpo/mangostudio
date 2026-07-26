import { type Static, Type } from '@sinclair/typebox';
import type { SkillSource } from '../skills';

export const ResourceKindSchema = Type.Union([
  Type.Literal('skill'),
  Type.Literal('subagent'),
  Type.Literal('instruction'),
  Type.Literal('setting'),
  Type.Literal('hook'),
]);

export const LibraryTargetIdSchema = Type.Union([
  Type.Literal('mangostudio'),
  Type.Literal('claude'),
  Type.Literal('codex'),
  Type.Literal('cursor'),
]);

/** Stable id of one code-defined library location. */
export const LibraryLocationIdSchema = Type.String({ minLength: 1, maxLength: 64 });

export const LocationAccessSchema = Type.Union([
  Type.Literal('read-write'),
  Type.Literal('read-only'),
]);

export const ResourceFormatSchema = Type.Union([
  Type.Literal('markdown-plain'),
  Type.Literal('markdown-frontmatter'),
  Type.Literal('mdc'),
  Type.Literal('toml-agent'),
  Type.Literal('agent-profile-db'),
  Type.Literal('json-settings'),
  Type.Literal('toml-settings'),
  Type.Literal('rules-dsl'),
]);

export const LibraryInvalidReasonSchema = Type.Literal('path-escape');

export const LIBRARY_RESOURCE_SLUG_MAX_LENGTH = 128;

/**
 * Path-safe shape a library resource slug must satisfy: dot-separated groups of
 * `[A-Za-z0-9_-]`. Rejects separators, `..`, leading/trailing dots, drive/stream
 * colons, whitespace and control characters, so a slug is always safe to use as
 * a single directory name or file stem.
 */
export const LIBRARY_RESOURCE_SLUG_PATTERN = '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$';

export const LibraryResourceRefSchema = Type.Object({
  kind: ResourceKindSchema,
  /** Logical name: skill directory name or file stem for file-backed resources. */
  slug: Type.String({
    minLength: 1,
    maxLength: LIBRARY_RESOURCE_SLUG_MAX_LENGTH,
    pattern: LIBRARY_RESOURCE_SLUG_PATTERN,
  }),
});

const libraryInstanceBase = {
  locationId: LibraryLocationIdSchema,
  /** Absolute path of the file or directory backing this instance. */
  path: Type.String({ minLength: 1 }),
  modifiedAtMs: Type.Integer({ minimum: 0 }),
  format: ResourceFormatSchema,
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
};

/** An instance whose content was read end to end, so it can be hashed and compared. */
export const ValidLibraryInstanceSchema = Type.Object({
  ...libraryInstanceBase,
  valid: Type.Literal(true),
  contentHash: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
});

/**
 * An instance that exists on disk but could not be hashed. It carries no `contentHash`,
 * so it never joins a `LibraryContentGroup` and never counts toward divergence.
 */
export const InvalidLibraryInstanceSchema = Type.Object({
  ...libraryInstanceBase,
  valid: Type.Literal(false),
  /** Why `valid` is false — a stable code, never free text. */
  invalidReason: LibraryInvalidReasonSchema,
});

export const LibraryInstanceSchema = Type.Union([
  ValidLibraryInstanceSchema,
  InvalidLibraryInstanceSchema,
]);

export const LibraryCoverageSchema = Type.Object({
  targetId: LibraryTargetIdSchema,
  state: Type.Union([Type.Literal('present'), Type.Literal('absent'), Type.Literal('shadowed')]),
  effectiveLocationId: Type.Optional(LibraryLocationIdSchema),
  shadowedLocationIds: Type.Array(LibraryLocationIdSchema),
});

export const LibraryDivergenceSchema = Type.Union([
  Type.Literal('uniform'),
  Type.Literal('divergent'),
  Type.Literal('single'),
]);

export const LibraryContentGroupSchema = Type.Object({
  contentHash: Type.String({ minLength: 1 }),
  locationIds: Type.Array(LibraryLocationIdSchema),
  instanceCount: Type.Integer({ minimum: 1 }),
});

export const LibraryResourceSchema = Type.Object({
  ref: LibraryResourceRefSchema,
  /** Stable identity for URLs and mutation keys: `<kind>:<slug>`. */
  key: Type.String({ minLength: 1 }),
  instances: Type.Array(LibraryInstanceSchema),
  coverage: Type.Array(LibraryCoverageSchema),
  divergence: LibraryDivergenceSchema,
  /** Distinct content hashes, most-replicated first. */
  contentGroups: Type.Array(LibraryContentGroupSchema),
});

export const LibraryLocationStatusSchema = Type.Object({
  id: LibraryLocationIdSchema,
  kind: ResourceKindSchema,
  /** Null when the code-defined location is unsupported on this platform. */
  path: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  access: LocationAccessSchema,
  exists: Type.Boolean(),
  readable: Type.Boolean(),
  writable: Type.Boolean(),
  targetIds: Type.Array(LibraryTargetIdSchema),
  entryCount: Type.Optional(Type.Integer({ minimum: 0 })),
});

const LibraryTargetReadsSchema = Type.Object({
  skill: Type.Array(LibraryLocationIdSchema),
  subagent: Type.Array(LibraryLocationIdSchema),
  instruction: Type.Array(LibraryLocationIdSchema),
  setting: Type.Array(LibraryLocationIdSchema),
  hook: Type.Array(LibraryLocationIdSchema),
});

export const LibraryTargetDescriptorSchema = Type.Object({
  id: LibraryTargetIdSchema,
  /** Key in the shared i18n catalog, never a user-visible literal. */
  displayNameKey: Type.String({ minLength: 1 }),
  /** Per-kind location precedence, highest priority first. */
  reads: LibraryTargetReadsSchema,
});

export type ResourceKind = Static<typeof ResourceKindSchema>;
export type LibraryTargetId = Static<typeof LibraryTargetIdSchema>;
export type LibraryLocationId = Static<typeof LibraryLocationIdSchema>;
export type LocationAccess = Static<typeof LocationAccessSchema>;
export type ResourceFormat = Static<typeof ResourceFormatSchema>;
export type LibraryInvalidReason = Static<typeof LibraryInvalidReasonSchema>;
export type LibraryResourceRef = Static<typeof LibraryResourceRefSchema>;
export type ValidLibraryInstance = Static<typeof ValidLibraryInstanceSchema>;
export type InvalidLibraryInstance = Static<typeof InvalidLibraryInstanceSchema>;
export type LibraryInstance = Static<typeof LibraryInstanceSchema>;
export type LibraryCoverage = Static<typeof LibraryCoverageSchema>;
export type LibraryDivergence = Static<typeof LibraryDivergenceSchema>;
export type LibraryContentGroup = Static<typeof LibraryContentGroupSchema>;
export type LibraryResource = Static<typeof LibraryResourceSchema>;
export type LibraryLocationStatus = Static<typeof LibraryLocationStatusSchema>;
export type LibraryTargetDescriptor = Static<typeof LibraryTargetDescriptorSchema>;

export const SKILL_SOURCE_TO_LOCATION_ID: Record<SkillSource, LibraryLocationId> = {
  mango: 'mango-skills',
  agents: 'agents-skills',
  claude: 'claude-skills',
};
