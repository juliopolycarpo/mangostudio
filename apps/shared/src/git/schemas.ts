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

const GitBranchNameSchema = Type.String({ minLength: 1, maxLength: 255 });
const GitCommitHashSchema = Type.String({ pattern: '^[0-9a-fA-F]{7,64}$' });

export const GitBranchSchema = Type.Object({
  name: GitBranchNameSchema,
  current: Type.Boolean(),
  upstream: Type.Optional(Type.String()),
  ahead: Type.Integer({ minimum: 0 }),
  behind: Type.Integer({ minimum: 0 }),
});

export const GitBranchesResponseSchema = Type.Object({
  branches: ReadonlyArraySchema(GitBranchSchema),
});

export const SwitchBranchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  name: GitBranchNameSchema,
});

export const CreateBranchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  name: GitBranchNameSchema,
});

export const GitHistoryQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  cursor: Type.Optional(Type.String({ pattern: '^\\d{1,10}$' })),
});

export const GitCommitSummarySchema = Type.Object({
  hash: GitCommitHashSchema,
  // `%h` honors `core.abbrev`, which repositories may configure below 7.
  shortHash: Type.String({ minLength: 4 }),
  subject: Type.String(),
  author: Type.String(),
  authoredAt: Type.String({ format: 'date-time' }),
  refs: ReadonlyArraySchema(Type.String()),
  changedFiles: Type.Integer({ minimum: 0 }),
  additions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
});

export const GitHistoryResponseSchema = Type.Object({
  commits: ReadonlyArraySchema(GitCommitSummarySchema),
  nextCursor: Type.Optional(Type.String({ pattern: '^\\d{1,10}$' })),
});

export const GitCommitQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  hash: GitCommitHashSchema,
});

export const GitCommitFileSchema = Type.Object({
  path: Type.String(),
  oldPath: Type.Optional(Type.String()),
  status: GitFileStatusSchema,
  additions: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  deletions: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

export const GitCommitDetailsResponseSchema = Type.Object({
  commit: GitCommitSummarySchema,
  files: ReadonlyArraySchema(GitCommitFileSchema),
});

export const GitDiffQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  staged: Type.Optional(Type.Boolean()),
  commit: Type.Optional(GitCommitHashSchema),
});

export const GitDiffResponseSchema = Type.Object({
  path: Type.String(),
  diff: Type.String(),
  binary: Type.Boolean(),
});

export const GitFetchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  prune: Type.Optional(Type.Boolean()),
});

export const GitRemoteBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
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
export type GitBranch = Static<typeof GitBranchSchema>;
export type GitBranchesResponse = Static<typeof GitBranchesResponseSchema>;
export type SwitchBranchBody = Static<typeof SwitchBranchBodySchema>;
export type CreateBranchBody = Static<typeof CreateBranchBodySchema>;
export type GitHistoryQuery = Static<typeof GitHistoryQuerySchema>;
export type GitCommitSummary = Static<typeof GitCommitSummarySchema>;
export type GitHistoryResponse = Static<typeof GitHistoryResponseSchema>;
export type GitCommitQuery = Static<typeof GitCommitQuerySchema>;
export type GitCommitFile = Static<typeof GitCommitFileSchema>;
export type GitCommitDetailsResponse = Static<typeof GitCommitDetailsResponseSchema>;
export type GitDiffQuery = Static<typeof GitDiffQuerySchema>;
export type GitDiffResponse = Static<typeof GitDiffResponseSchema>;
export type GitFetchBody = Static<typeof GitFetchBodySchema>;
export type GitRemoteBody = Static<typeof GitRemoteBodySchema>;
