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
  Type.Literal('agent-profile-db'),
  Type.Literal('json-settings'),
  Type.Literal('toml-settings'),
  Type.Literal('rules-dsl'),
]);

export const LibraryInvalidReasonSchema = Type.Literal('path-escape');

export const LibraryResourceRefSchema = Type.Object({
  kind: ResourceKindSchema,
  /** Logical name: skill directory name or file stem for file-backed resources. */
  slug: Type.String({ minLength: 1, maxLength: 128 }),
});

export const LibraryInstanceSchema = Type.Object({
  locationId: LibraryLocationIdSchema,
  /** Absolute path of the file or directory backing this instance. */
  path: Type.String({ minLength: 1 }),
  contentHash: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  modifiedAtMs: Type.Integer({ minimum: 0 }),
  format: ResourceFormatSchema,
  valid: Type.Boolean(),
  invalidReason: Type.Optional(LibraryInvalidReasonSchema),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
});

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

export type ResourceKind = Static<typeof ResourceKindSchema>;
export type LibraryTargetId = Static<typeof LibraryTargetIdSchema>;
export type LibraryLocationId = Static<typeof LibraryLocationIdSchema>;
export type LocationAccess = Static<typeof LocationAccessSchema>;
export type ResourceFormat = Static<typeof ResourceFormatSchema>;
export type LibraryInvalidReason = Static<typeof LibraryInvalidReasonSchema>;
export type LibraryResourceRef = Static<typeof LibraryResourceRefSchema>;
export type LibraryInstance = Static<typeof LibraryInstanceSchema>;
export type LibraryCoverage = Static<typeof LibraryCoverageSchema>;
export type LibraryDivergence = Static<typeof LibraryDivergenceSchema>;
export type LibraryContentGroup = Static<typeof LibraryContentGroupSchema>;
export type LibraryResource = Static<typeof LibraryResourceSchema>;

export const SKILL_SOURCE_TO_LOCATION_ID: Record<SkillSource, LibraryLocationId> = {
  mango: 'mango-skills',
  agents: 'agents-skills',
  claude: 'claude-skills',
};
