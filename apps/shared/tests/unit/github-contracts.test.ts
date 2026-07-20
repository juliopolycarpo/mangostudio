import { describe, expect, it } from 'bun:test';
import {
  GithubContextQuerySchema,
  GithubContextSchema,
  GithubPrSchema,
  GithubRepoSchema,
} from '@mangostudio/shared/github';
import { Value } from '@sinclair/typebox/value';

const repo = {
  nameWithOwner: 'mango/mangostudio',
  defaultBranch: 'main',
  url: 'https://github.example/mango/mangostudio',
};

const pr = {
  number: 42,
  title: 'Expose GitHub context',
  state: 'OPEN',
  isDraft: true,
  url: 'https://github.example/mango/mangostudio/pull/42',
  headRefName: 'feat/github-context',
  baseRefName: 'main',
};

describe('GitHub contracts', () => {
  it('validates repository and pull request data', () => {
    expect(Value.Check(GithubRepoSchema, repo)).toBe(true);
    expect(Value.Check(GithubPrSchema, pr)).toBe(true);
    expect(Value.Check(GithubPrSchema, { ...pr, state: 'UNKNOWN' })).toBe(false);
    expect(Value.Check(GithubPrSchema, { ...pr, number: 0 })).toBe(false);
  });

  it('distinguishes unavailable states from successful context', () => {
    for (const state of [
      'gh-not-installed',
      'not-authenticated',
      'no-remote',
      'not-a-github-remote',
    ]) {
      expect(Value.Check(GithubContextSchema, { state }), state).toBe(true);
    }

    expect(Value.Check(GithubContextSchema, { state: 'ok', repo, pr })).toBe(true);
    expect(Value.Check(GithubContextSchema, { state: 'ok', repo, pr: null })).toBe(true);
    expect(Value.Check(GithubContextSchema, { state: 'ok', repo })).toBe(false);
  });

  it('requires a non-empty chat id', () => {
    expect(Value.Check(GithubContextQuerySchema, { chatId: 'chat-1' })).toBe(true);
    expect(Value.Check(GithubContextQuerySchema, { chatId: '' })).toBe(false);
  });
});
