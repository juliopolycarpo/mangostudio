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

const GitPathsSchema = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  uniqueItems: true,
});

function writePathsBodySchema() {
  return Type.Union([
    Type.Object({
      chatId: Type.String({ minLength: 1 }),
      paths: GitPathsSchema,
      all: Type.Optional(Type.Literal(false)),
    }),
    Type.Object({
      chatId: Type.String({ minLength: 1 }),
      all: Type.Literal(true),
      paths: Type.Optional(GitPathsSchema),
    }),
  ]);
}

export const StagePathsBodySchema = writePathsBodySchema();
export const UnstagePathsBodySchema = writePathsBodySchema();

// The first and last non-whitespace characters bound the trimmed title to
// 1..72 characters while still accepting harmless surrounding spaces.
const CommitTitleSchema = Type.String({
  pattern: '^[\\t ]*[^\\s\\r\\n](?:[^\\r\\n]{0,70}[^\\s\\r\\n])?[\\t ]*$',
});

export const CommitBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  title: CommitTitleSchema,
  body: Type.Optional(Type.String()),
  amend: Type.Optional(Type.Boolean()),
});

export const CommitResponseSchema = Type.Object({
  hash: Type.String({ minLength: 1 }),
  subject: Type.String({ minLength: 1 }),
});

export const GenerateCommitMessageBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String({ minLength: 1 })),
});

export const GenerateCommitMessageResponseSchema = Type.Object({
  title: Type.String(),
  body: Type.String(),
  truncated: Type.Boolean(),
});

export const StashSaveBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  message: Type.Optional(Type.String()),
  includeUntracked: Type.Optional(Type.Boolean()),
});

export const StashPopBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
});

export const StashEntrySchema = Type.Object({
  index: Type.Integer({ minimum: 0 }),
  message: Type.String(),
  branch: Type.Optional(Type.String()),
});

export const StashListResponseSchema = Type.Object({
  stashes: ReadonlyArraySchema(StashEntrySchema),
});

export type GitFileStatus = Static<typeof GitFileStatusSchema>;
export type GitFileChange = Static<typeof GitFileChangeSchema>;
export type GitBranchInfo = Static<typeof GitBranchInfoSchema>;
export type GitStatus = Static<typeof GitStatusSchema>;
export type GitRepoState = Static<typeof GitRepoStateSchema>;
export type GitStateQuery = Static<typeof GitStateQuerySchema>;
export type InitRepoBody = Static<typeof InitRepoBodySchema>;
export type InitRepoResponse = Static<typeof InitRepoResponseSchema>;
export type StagePathsBody = Static<typeof StagePathsBodySchema>;
export type UnstagePathsBody = Static<typeof UnstagePathsBodySchema>;
export type CommitBody = Static<typeof CommitBodySchema>;
export type CommitResponse = Static<typeof CommitResponseSchema>;
export type GenerateCommitMessageBody = Static<typeof GenerateCommitMessageBodySchema>;
export type GenerateCommitMessageResponse = Static<typeof GenerateCommitMessageResponseSchema>;
export type StashSaveBody = Static<typeof StashSaveBodySchema>;
export type StashPopBody = Static<typeof StashPopBodySchema>;
export type StashEntry = Static<typeof StashEntrySchema>;
export type StashListResponse = Static<typeof StashListResponseSchema>;
