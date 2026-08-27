import { describe, expect, it } from 'bun:test';
import {
  GITHUB_PR_REVIEW_THREADS_QUERY,
  isPinnedGithubGraphqlDocument,
  PINNED_GITHUB_GRAPHQL_DOCUMENTS,
} from '../../src/github/graphql-documents';

describe('pinned GitHub GraphQL documents', () => {
  it('pins the review-thread query with every field its consumers read', () => {
    for (const field of [
      '$owner: String!',
      '$name: String!',
      '$number: Int!',
      'isResolved',
      'isOutdated',
      'path',
      'line',
      'author { login }',
      'body',
    ]) {
      expect(GITHUB_PR_REVIEW_THREADS_QUERY).toContain(field);
    }
    expect(PINNED_GITHUB_GRAPHQL_DOCUMENTS).toContain(GITHUB_PR_REVIEW_THREADS_QUERY);
  });

  it('accepts every pinned document', () => {
    for (const document of PINNED_GITHUB_GRAPHQL_DOCUMENTS) {
      expect(isPinnedGithubGraphqlDocument(document)).toBe(true);
    }
  });

  it('accepts a reflowed document because layout carries no fields', () => {
    const reflowed = `  ${GITHUB_PR_REVIEW_THREADS_QUERY.replace(/\s+/g, '\n\t')}  `;
    expect(reflowed).not.toBe(GITHUB_PR_REVIEW_THREADS_QUERY);
    expect(isPinnedGithubGraphqlDocument(reflowed)).toBe(true);
  });

  it('refuses a document that asks for a field this module never shipped', () => {
    const extended = GITHUB_PR_REVIEW_THREADS_QUERY.replace(
      'isResolved',
      'isResolved\n          viewerCanDelete'
    );
    expect(isPinnedGithubGraphqlDocument(extended)).toBe(false);
  });

  it('refuses unrelated, empty, and non-string documents', () => {
    expect(isPinnedGithubGraphqlDocument('query { viewer { login } }')).toBe(false);
    expect(isPinnedGithubGraphqlDocument('')).toBe(false);
    expect(isPinnedGithubGraphqlDocument(undefined as unknown as string)).toBe(false);
  });

  it('freezes the pinned set so a consumer cannot widen it at runtime', () => {
    expect(Object.isFrozen(PINNED_GITHUB_GRAPHQL_DOCUMENTS)).toBe(true);
  });
});
