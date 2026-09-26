import { describe, expect, it } from 'bun:test';
import {
  GITHUB_PR_REVIEW_THREADS_QUERY,
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

  it('freezes the pinned set so a consumer cannot widen it at runtime', () => {
    expect(Object.isFrozen(PINNED_GITHUB_GRAPHQL_DOCUMENTS)).toBe(true);
  });
});
