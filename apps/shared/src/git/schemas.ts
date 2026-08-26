import Type, { type Static } from 'typebox';
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

/** Callers batch the rows they can see, not the whole chat history. */
export const GIT_BATCH_STATE_MAX_CHAT_IDS = 50;

export const GitBatchStateRequestSchema = Type.Object({
  chatIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: GIT_BATCH_STATE_MAX_CHAT_IDS,
    uniqueItems: true,
  }),
});

/**
 * The slim per-chat shape list surfaces render as badges. Deliberately not
 * `GitStatusSchema`: a 50-chat batch never needs per-file changes, only the
 * branch line and how much is dirty. A clean tree is `changedFileCount === 0`
 * rather than a second field that could disagree with it.
 *
 * The upstream's *name* is deliberately absent too — a badge shows how far a
 * branch has drifted, not what it tracks. `GET /git/state` carries
 * `branch.upstream` for the panel that does name it.
 */
export const GitSummarySchema = Type.Object({
  branch: Type.Union([Type.String(), Type.Null()]),
  detachedAt: Type.Optional(Type.String()),
  ahead: Type.Integer({ minimum: 0 }),
  behind: Type.Integer({ minimum: 0 }),
  changedFileCount: Type.Integer({ minimum: 0 }),
  workdir: Type.String(),
});

/**
 * A requested chat with no answer is simply absent from `states`. That covers
 * no workdir, not a repository, Git unavailable, a transient failure reading
 * the repository, and a chat this user cannot read — indistinguishable on
 * purpose: a batch response must not reveal whether a foreign chat id exists.
 */
export const GitBatchStateResponseSchema = Type.Object({
  states: Type.Record(Type.String({ minLength: 1 }), GitSummarySchema),
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

export const DiscardPathsBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  paths: GitPathsSchema,
  mode: Type.Union([Type.Literal('tracked'), Type.Literal('untracked')]),
});

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

function stashRefBodySchema() {
  return Type.Object({
    chatId: Type.String({ minLength: 1 }),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
  });
}

export const StashPopBodySchema = stashRefBodySchema();
export const StashApplyBodySchema = stashRefBodySchema();
export const StashDropBodySchema = stashRefBodySchema();

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

export const GitRemoteBranchSchema = Type.Object({
  name: GitBranchNameSchema,
  remote: GitBranchNameSchema,
  ref: Type.String({ minLength: 1, maxLength: 512 }),
});

export const GitBranchesResponseSchema = Type.Object({
  branches: ReadonlyArraySchema(GitBranchSchema),
  remotes: ReadonlyArraySchema(GitRemoteBranchSchema),
});

export const SwitchBranchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  name: GitBranchNameSchema,
});

export const CheckoutRemoteBranchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  remoteRef: Type.String({ minLength: 1, maxLength: 512 }),
});

export const CreateBranchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  name: GitBranchNameSchema,
});

export const DeleteBranchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  name: GitBranchNameSchema,
  force: Type.Optional(Type.Boolean()),
});

export const RenameBranchBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  name: GitBranchNameSchema,
  newName: GitBranchNameSchema,
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

/**
 * `force` is a literal rather than a boolean so a plain `--force` is not
 * expressible on the wire: the only forced push this API can build is a leased
 * one, which still refuses to overwrite refs the client has not seen.
 */
export const GitPushBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  force: Type.Optional(Type.Literal('with-lease')),
});

export const GitHeadMessageResponseSchema = Type.Object({
  hash: GitCommitHashSchema,
  title: Type.String(),
  body: Type.String(),
});

/**
 * A filesystem path on the machine that owns the repository, not a repository
 * pathspec: a worktree deliberately lives outside the repository root, so the
 * containment rules that guard `GitPathsSchema` do not apply here. The cap is
 * a sanity bound on what a caller may type, well above every platform's own
 * `PATH_MAX`.
 */
const GitWorktreePathSchema = Type.String({ minLength: 1, maxLength: 4096 });

/**
 * A single entry of `git worktree list`.
 *
 * `head` and `branch` are both nullable, for two different reasons: a bare
 * repository's entry carries neither, and a detached worktree carries a commit
 * but no branch. `branch` holds the short name (`feat/x`) rather than the
 * `refs/heads/feat/x` Git prints, so it matches `GitBranchSchema.name` — but it
 * is capped like a ref rather than like a branch name, because a ref Git
 * already accepted must render in the panel instead of failing validation.
 *
 * The lock and prune reasons are free text Git echoes back, and both are absent
 * rather than empty when the state applies without one.
 */
export const GitWorktreeSchema = Type.Object({
  path: GitWorktreePathSchema,
  head: Type.Union([GitCommitHashSchema, Type.Null()]),
  branch: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  isMain: Type.Boolean(),
  isBare: Type.Boolean(),
  isDetached: Type.Boolean(),
  isLocked: Type.Boolean(),
  lockReason: Type.Optional(Type.String()),
  isPrunable: Type.Boolean(),
  prunableReason: Type.Optional(Type.String()),
});

export const GitWorktreeListResponseSchema = Type.Object({
  worktrees: ReadonlyArraySchema(GitWorktreeSchema),
});

/**
 * The two shapes of `git worktree add`, as a closed union rather than a
 * `branch` plus a `createBranch` flag: the mode picks the Git command
 * (`worktree add -b <branch> -- <path>` against `worktree add -- <path>
 * <branch>`), and a bag of optional fields would let a caller ask for a
 * combination neither command can express.
 */
function addWorktreeVariantSchema<Mode extends string>(mode: Mode) {
  return Type.Object({
    chatId: Type.String({ minLength: 1 }),
    path: GitWorktreePathSchema,
    mode: Type.Literal(mode),
    branch: GitBranchNameSchema,
  });
}

export const AddWorktreeBodySchema = Type.Union([
  addWorktreeVariantSchema('existing-branch'),
  addWorktreeVariantSchema('new-branch'),
]);

export const RemoveWorktreeBodySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
  path: GitWorktreePathSchema,
  force: Type.Optional(Type.Boolean()),
});

export type GitFileStatus = Static<typeof GitFileStatusSchema>;
export type GitFileChange = Static<typeof GitFileChangeSchema>;
export type GitBranchInfo = Static<typeof GitBranchInfoSchema>;
export type GitStatus = Static<typeof GitStatusSchema>;
export type GitRepoState = Static<typeof GitRepoStateSchema>;
export type GitStateQuery = Static<typeof GitStateQuerySchema>;
export type GitBatchStateRequest = Static<typeof GitBatchStateRequestSchema>;
export type GitSummary = Static<typeof GitSummarySchema>;
export type GitBatchStateResponse = Static<typeof GitBatchStateResponseSchema>;
export type InitRepoBody = Static<typeof InitRepoBodySchema>;
export type InitRepoResponse = Static<typeof InitRepoResponseSchema>;
export type StagePathsBody = Static<typeof StagePathsBodySchema>;
export type UnstagePathsBody = Static<typeof UnstagePathsBodySchema>;
export type DiscardPathsBody = Static<typeof DiscardPathsBodySchema>;
export type CommitBody = Static<typeof CommitBodySchema>;
export type CommitResponse = Static<typeof CommitResponseSchema>;
export type GenerateCommitMessageBody = Static<typeof GenerateCommitMessageBodySchema>;
export type GenerateCommitMessageResponse = Static<typeof GenerateCommitMessageResponseSchema>;
export type StashSaveBody = Static<typeof StashSaveBodySchema>;
export type StashPopBody = Static<typeof StashPopBodySchema>;
export type StashApplyBody = Static<typeof StashApplyBodySchema>;
export type StashDropBody = Static<typeof StashDropBodySchema>;
export type StashEntry = Static<typeof StashEntrySchema>;
export type StashListResponse = Static<typeof StashListResponseSchema>;
export type GitBranch = Static<typeof GitBranchSchema>;
export type GitRemoteBranch = Static<typeof GitRemoteBranchSchema>;
export type GitBranchesResponse = Static<typeof GitBranchesResponseSchema>;
export type SwitchBranchBody = Static<typeof SwitchBranchBodySchema>;
export type CheckoutRemoteBranchBody = Static<typeof CheckoutRemoteBranchBodySchema>;
export type CreateBranchBody = Static<typeof CreateBranchBodySchema>;
export type DeleteBranchBody = Static<typeof DeleteBranchBodySchema>;
export type RenameBranchBody = Static<typeof RenameBranchBodySchema>;
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
export type GitPushBody = Static<typeof GitPushBodySchema>;
export type GitHeadMessageResponse = Static<typeof GitHeadMessageResponseSchema>;
export type GitWorktree = Static<typeof GitWorktreeSchema>;
export type GitWorktreeListResponse = Static<typeof GitWorktreeListResponseSchema>;
export type AddWorktreeBody = Static<typeof AddWorktreeBodySchema>;
export type RemoveWorktreeBody = Static<typeof RemoveWorktreeBodySchema>;
