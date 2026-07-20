import { type Static, Type } from '@sinclair/typebox';
import { ReadonlyArraySchema } from '../schema-helpers';

export const GitFileStatusSchema = Type.Union([
  Type.Literal('modified'),
  Type.Literal('added'),
  Type.Literal('deleted'),
  Type.Literal('renamed'),
  Type.Literal('copied'),
  Type.Literal('untracked'),
  Type.Literal('conflicted'),
  Type.Literal('type-changed'),
]);

export const GitFileChangeSchema = Type.Object({
  path: Type.String(),
  status: GitFileStatusSchema,
  oldPath: Type.Optional(Type.String()),
});

export const GitBranchInfoSchema = Type.Object({
  name: Type.Union([Type.String(), Type.Null()]),
  detachedAt: Type.Optional(Type.String()),
  upstream: Type.Optional(Type.String()),
  ahead: Type.Number({ minimum: 0 }),
  behind: Type.Number({ minimum: 0 }),
});

const GitFileChangesSchema = ReadonlyArraySchema(GitFileChangeSchema);

export const GitStatusSchema = Type.Object({
  branch: GitBranchInfoSchema,
  staged: GitFileChangesSchema,
  unstaged: GitFileChangesSchema,
  untracked: GitFileChangesSchema,
  conflicted: GitFileChangesSchema,
  clean: Type.Boolean(),
});

export const GitRepoStateSchema = Type.Union([
  Type.Object({ state: Type.Literal('git-unavailable') }),
  Type.Object({ state: Type.Literal('no-workdir') }),
  Type.Object({ state: Type.Literal('not-a-repo'), workdir: Type.String() }),
  Type.Object({
    state: Type.Literal('repo'),
    workdir: Type.String(),
    root: Type.String(),
    status: GitStatusSchema,
  }),
]);

export const GitStateQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
});

export const InitRepoBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
});

export const InitRepoResponseSchema = Type.Object({
  root: Type.String(),
});

export type GitFileStatus = Static<typeof GitFileStatusSchema>;
export type GitFileChange = Static<typeof GitFileChangeSchema>;
export type GitBranchInfo = Static<typeof GitBranchInfoSchema>;
export type GitStatus = Static<typeof GitStatusSchema>;
export type GitRepoState = Static<typeof GitRepoStateSchema>;
export type GitStateQuery = Static<typeof GitStateQuerySchema>;
export type InitRepoBody = Static<typeof InitRepoBodySchema>;
export type InitRepoResponse = Static<typeof InitRepoResponseSchema>;
