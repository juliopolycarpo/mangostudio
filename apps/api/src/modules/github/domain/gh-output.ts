/**
 * What `gh --json` actually emits, and the one way to read it.
 *
 * These schemas describe gh's wire shape, not this product's contract. They are
 * deliberately *looser* than `@mangostudio/shared/github`: `state` is a plain
 * string here because `gh search prs` spells it lowercase, `reviewDecision` is
 * an optional string because gh spells "no decision" as `""`, and `author`
 * carries gh's snake_case `is_bot`. Tightening happens in one place — the
 * normalizers — so every endpoint disagrees with gh identically.
 *
 * Unknown keys are accepted on purpose. gh adds fields between releases, and a
 * read-only side panel that 500s because a new one appeared would be a worse
 * failure than ignoring it.
 */

import Type, { type Static, type TSchema } from 'typebox';
import Value from 'typebox/value';
import type { GhCommandId } from './gh-command-registry';

/**
 * gh produced something this build cannot read.
 *
 * Carries the command rather than the output: the output is gh's stdout, which
 * is exactly what must not reach a response body.
 */
export class GithubOutputError extends Error {
  readonly code = 'GH_OUTPUT_INVALID';

  constructor(readonly command: GhCommandId) {
    super(`GitHub CLI returned unreadable output for ${command}.`);
    this.name = 'GithubOutputError';
  }
}

/** gh's actor, with the one snake_case key in an otherwise camelCase payload. */
const GhActorSchema = Type.Object({
  login: Type.String(),
  is_bot: Type.Optional(Type.Boolean()),
});

const GhNullableActorSchema = Type.Optional(Type.Union([GhActorSchema, Type.Null()]));

const GhLabelSchema = Type.Object({ name: Type.String(), color: Type.String() });
const GhLabelsSchema = Type.Optional(Type.Array(GhLabelSchema));

/** Left `Unknown`: the rollup's own two variants are the reducer's problem. */
const GhRollupSchema = Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Null()]));

export const GhRepoOutputSchema = Type.Object({
  nameWithOwner: Type.String(),
  defaultBranchRef: Type.Object({ name: Type.String() }),
  url: Type.String(),
});

export const GhPrSummaryOutputSchema = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  url: Type.String(),
  state: Type.String(),
  isDraft: Type.Boolean(),
  headRefName: Type.String(),
  baseRefName: Type.String(),
  updatedAt: Type.String(),
  author: GhNullableActorSchema,
  labels: GhLabelsSchema,
  reviewDecision: Type.Optional(Type.String()),
  statusCheckRollup: GhRollupSchema,
});

export const GhPrSummaryListSchema = Type.Array(GhPrSummaryOutputSchema);

export const GhPrDetailOutputSchema = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.String(),
  url: Type.String(),
  reviewDecision: Type.Optional(Type.String()),
  mergeStateStatus: Type.Optional(Type.String()),
  mergeable: Type.Optional(Type.String()),
  changedFiles: Type.Integer(),
  additions: Type.Integer(),
  deletions: Type.Integer(),
  latestReviews: Type.Optional(
    Type.Array(
      Type.Object({
        author: GhNullableActorSchema,
        state: Type.String(),
        body: Type.Optional(Type.String()),
        submittedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      })
    )
  ),
  labels: GhLabelsSchema,
});

export const GhCheckRunListSchema = Type.Array(
  Type.Object({
    name: Type.Optional(Type.String()),
    bucket: Type.String(),
    state: Type.String(),
    link: Type.Optional(Type.String()),
    workflow: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    startedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    completedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  })
);

export const GhIssueListSchema = Type.Array(
  Type.Object({
    number: Type.Integer(),
    title: Type.String(),
    url: Type.String(),
    state: Type.String(),
    updatedAt: Type.String(),
    author: GhNullableActorSchema,
    labels: GhLabelsSchema,
    assignees: Type.Optional(Type.Array(GhActorSchema)),
  })
);

export const GhSearchPrListSchema = Type.Array(
  Type.Object({
    number: Type.Integer(),
    title: Type.String(),
    url: Type.String(),
    state: Type.String(),
    isDraft: Type.Boolean(),
    updatedAt: Type.String(),
    author: GhNullableActorSchema,
    labels: GhLabelsSchema,
    repository: Type.Object({ nameWithOwner: Type.String() }),
  })
);

/**
 * The pinned review-threads document's response, as `gh api graphql` returns it.
 *
 * `line` is null on an outdated thread and `author` is null on a comment whose
 * account was deleted — both from real responses, both required here so a
 * consumer cannot forget them.
 */
export const GhReviewThreadsOutputSchema = Type.Object({
  data: Type.Object({
    repository: Type.Object({
      pullRequest: Type.Object({
        reviewThreads: Type.Object({
          totalCount: Type.Integer(),
          nodes: Type.Array(
            Type.Object({
              isResolved: Type.Boolean(),
              isOutdated: Type.Boolean(),
              path: Type.String(),
              line: Type.Union([Type.Integer(), Type.Null()]),
              comments: Type.Object({
                totalCount: Type.Integer(),
                nodes: Type.Array(
                  Type.Object({
                    author: GhNullableActorSchema,
                    body: Type.String(),
                  })
                ),
              }),
            })
          ),
        }),
      }),
    }),
  }),
});

export type GhActorOutput = Static<typeof GhActorSchema>;
export type GhPrSummaryOutput = Static<typeof GhPrSummaryOutputSchema>;
export type GhPrDetailOutput = Static<typeof GhPrDetailOutputSchema>;
export type GhCheckRunListOutput = Static<typeof GhCheckRunListSchema>;
export type GhIssueListOutput = Static<typeof GhIssueListSchema>;
export type GhSearchPrListOutput = Static<typeof GhSearchPrListSchema>;
export type GhReviewThreadsOutput = Static<typeof GhReviewThreadsOutputSchema>;

/**
 * Parses one command's stdout, checks it, and maps it to a contract shape.
 *
 * The mapper runs inside the same guard as the parse on purpose. A normalizer
 * that meets a value gh has never emitted — a fourth pull request state, a
 * review verdict this build does not know — should fail the same way malformed
 * JSON does: as "gh produced something unreadable", labelled with the command,
 * with gh's own output kept out of the error. Without this, every normalizer
 * would need either its own command id or a silent fallback that reports the
 * wrong thing rather than nothing.
 *
 * @example
 * readGhOutput('pr.list', result.stdout, GhPrSummaryListSchema, toPrSummaries);
 */
export function readGhOutput<S extends TSchema, T>(
  command: GhCommandId,
  stdout: string,
  schema: S,
  map: (raw: Static<S>) => T
): T {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new GithubOutputError(command);
  }
  if (!Value.Check(schema, value)) throw new GithubOutputError(command);
  try {
    return map(value as Static<S>);
  } catch {
    throw new GithubOutputError(command);
  }
}
