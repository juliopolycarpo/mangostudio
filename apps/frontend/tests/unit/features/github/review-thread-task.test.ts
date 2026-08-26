/**
 * The composer formatter: which review threads survive the filter, and what
 * the agent ends up reading.
 *
 * The filter is the part worth pinning. Sending a resolved or outdated thread
 * asks an agent to re-do settled work, and a task list that includes finished
 * items is one the reader stops trusting after the first time.
 */

import { describe, expect, it } from 'bun:test';
import type { GithubReviewThread } from '@mangostudio/shared/github';
import { en } from '@mangostudio/shared/i18n';
import {
  openReviewThreads,
  reviewThreadsToTask,
} from '../../../../src/features/github/lib/review-thread-task';

const labels = en.github.reviewTask;

function thread(overrides: Partial<GithubReviewThread> = {}): GithubReviewThread {
  return {
    isResolved: false,
    isOutdated: false,
    path: 'src/features/github/queries.ts',
    line: 42,
    comments: [{ author: { login: 'alice' }, body: 'Rename this to something honest.' }],
    ...overrides,
  };
}

describe('openReviewThreads', () => {
  it('keeps only threads that are neither resolved nor outdated', () => {
    const threads = [
      thread({ path: 'a.ts' }),
      thread({ path: 'b.ts', isResolved: true }),
      thread({ path: 'c.ts', isOutdated: true, line: null }),
      thread({ path: 'd.ts', isResolved: true, isOutdated: true, line: null }),
    ];

    expect(openReviewThreads(threads).map((item) => item.path)).toEqual(['a.ts']);
  });

  it('returns nothing when every thread is settled', () => {
    expect(openReviewThreads([thread({ isResolved: true })])).toEqual([]);
  });
});

describe('reviewThreadsToTask', () => {
  it('numbers each thread and anchors it to a file and line', () => {
    const task = reviewThreadsToTask(
      [thread({ path: 'a.ts', line: 7 }), thread({ path: 'b.ts', line: 9 })],
      'mango/studio#942',
      labels
    );

    expect(task).toContain('Address these unresolved review comments on mango/studio#942:');
    expect(task).toContain('1. a.ts:7');
    expect(task).toContain('2. b.ts:9');
  });

  it('drops the line number on a thread anchored to a whole file', () => {
    const task = reviewThreadsToTask([thread({ path: 'a.ts', line: null })], 'o/r#1', labels);

    expect(task).toContain('1. a.ts');
    expect(task).not.toContain('a.ts:');
  });

  it('names the ghost user rather than dropping a deleted account comment', () => {
    const task = reviewThreadsToTask(
      [thread({ comments: [{ author: null, body: 'Still needs a test.' }] })],
      'o/r#1',
      labels
    );

    expect(task).toContain('someone: Still needs a test.');
  });

  it('collapses a multi-paragraph review body onto one line', () => {
    const task = reviewThreadsToTask(
      [thread({ comments: [{ author: { login: 'bob' }, body: 'First.\n\n  Second.\n' }] })],
      'o/r#1',
      labels
    );

    expect(task).toContain('bob: First. Second.');
  });

  it('keeps every comment in a thread, in order', () => {
    const task = reviewThreadsToTask(
      [
        thread({
          comments: [
            { author: { login: 'alice' }, body: 'One.' },
            { author: { login: 'bob' }, body: 'Two.' },
          ],
        }),
      ],
      'o/r#1',
      labels
    );

    expect(task.indexOf('alice: One.')).toBeLessThan(task.indexOf('bob: Two.'));
  });

  it('is empty when nothing is open, so the caller has one thing to test', () => {
    expect(reviewThreadsToTask([thread({ isResolved: true })], 'o/r#1', labels)).toBe('');
    expect(reviewThreadsToTask([], 'o/r#1', labels)).toBe('');
  });
});
