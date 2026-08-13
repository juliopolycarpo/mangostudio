import Type, { type Static } from 'typebox';

export const GithubPrStateSchema = Type.Union([
  Type.Literal('OPEN'),
  Type.Literal('CLOSED'),
  Type.Literal('MERGED'),
]);

export const GithubPrSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  state: GithubPrStateSchema,
  isDraft: Type.Boolean(),
  url: Type.String(),
  headRefName: Type.String(),
  baseRefName: Type.String(),
});

export const GithubRepoSchema = Type.Object({
  nameWithOwner: Type.String(),
  defaultBranch: Type.String(),
  url: Type.String(),
});

export const GithubContextSchema = Type.Union([
  Type.Object({ state: Type.Literal('gh-not-installed') }),
  Type.Object({ state: Type.Literal('not-authenticated') }),
  Type.Object({ state: Type.Literal('no-remote') }),
  Type.Object({ state: Type.Literal('not-a-github-remote') }),
  Type.Object({
    state: Type.Literal('ok'),
    repo: GithubRepoSchema,
    pr: Type.Union([GithubPrSchema, Type.Null()]),
  }),
]);

export const GithubContextQuerySchema = Type.Object({
  chatId: Type.String({ minLength: 1 }),
});

export type GithubPrState = Static<typeof GithubPrStateSchema>;
export type GithubPr = Static<typeof GithubPrSchema>;
export type GithubRepo = Static<typeof GithubRepoSchema>;
export type GithubContext = Static<typeof GithubContextSchema>;
export type GithubContextQuery = Static<typeof GithubContextQuerySchema>;
