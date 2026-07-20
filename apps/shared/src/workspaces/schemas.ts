import { type Static, Type } from '@sinclair/typebox';

export const DirectoryEntrySchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  hidden: Type.Optional(Type.Boolean()),
});

export const ListDirectoryResponseSchema = Type.Object({
  path: Type.String(),
  parent: Type.Union([Type.String(), Type.Null()]),
  entries: Type.Array(DirectoryEntrySchema),
  home: Type.String(),
  roots: Type.Array(Type.String()),
  separator: Type.Union([Type.Literal('/'), Type.Literal('\\')]),
});

export const ValidatePathBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});

export const WorkdirValidationReasonSchema = Type.Union([
  Type.Literal('not-found'),
  Type.Literal('not-a-directory'),
  Type.Literal('permission-denied'),
]);

export const ValidatePathResponseSchema = Type.Object({
  ok: Type.Boolean(),
  resolvedPath: Type.Optional(Type.String()),
  reason: Type.Optional(WorkdirValidationReasonSchema),
});

/** Upper bound on remembered working directories, shared by the schema, normalizer, and UI. */
export const RECENT_WORKDIRS_MAX = 10;

export const WorkspaceSettingsSchema = Type.Object({
  defaultWorkdir: Type.String(),
  recentWorkdirs: Type.Array(Type.String(), { maxItems: RECENT_WORKDIRS_MAX }),
});

export type DirectoryEntry = Static<typeof DirectoryEntrySchema>;
export type ListDirectoryResponse = Static<typeof ListDirectoryResponseSchema>;
export type ValidatePathBody = Static<typeof ValidatePathBodySchema>;
export type WorkdirValidationReason = Static<typeof WorkdirValidationReasonSchema>;
export type ValidatePathResponse = Static<typeof ValidatePathResponseSchema>;
export type WorkspaceSettings = Static<typeof WorkspaceSettingsSchema>;
