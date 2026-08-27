/**
 * What the detail view says when one of its three reads fails on its own.
 *
 * `gh pr view`, `gh pr checks` and the review-threads GraphQL document answer
 * separately, so two of them can succeed while the third rate-limits or fails
 * in a way this build does not recognize. Silence there is indistinguishable
 * from "no checks" and "nothing to address" — the two sentences somebody acts
 * on — so each block owns its own failure and its own retry.
 */

import { describe, expect, it, jest } from 'bun:test';
import { screen } from '@testing-library/react';
import { GithubPrDetail } from '../../../../src/features/github/components/GithubPrDetail';
import { flushAsyncRender, render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const CHAT_ID = 'chat-1';
const NUMBER = 942;

const DETAIL_PATH = `/api/github/pr?chatId=${CHAT_ID}&number=${NUMBER}`;
const CHECKS_PATH = `/api/github/pr/checks?chatId=${CHAT_ID}&number=${NUMBER}`;
const THREADS_PATH = `/api/github/pr/review-threads?chatId=${CHAT_ID}&number=${NUMBER}`;

const DETAIL_OK = {
  state: 'ok',
  cachedAt: 1_700_000_000_000,
  repo: { nameWithOwner: 'mango/studio' },
  pr: {
    number: NUMBER,
    title: 'Build the GitHub rail panel',
    url: 'https://github.com/mango/studio/pull/942',
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
  },
};

const THREADS_OK = {
  state: 'ok',
  cachedAt: 1_700_000_000_000,
  repo: { nameWithOwner: 'mango/studio' },
  threads: [],
  truncated: false,
};

function scenarioWith(overrides: { checksStatus?: number; threadsStatus?: number }) {
  const scenario = createFetchScenario();
  scenario
    .respondWithJson('GET', DETAIL_PATH, { body: DETAIL_OK })
    .respondWithJson('GET', CHECKS_PATH, {
      status: overrides.checksStatus ?? 200,
      body:
        overrides.checksStatus === undefined
          ? { state: 'ok', cachedAt: 1_700_000_000_000, checks: [], summary: null }
          : { message: 'rate limited' },
    })
    .respondWithJson('GET', THREADS_PATH, {
      status: overrides.threadsStatus ?? 200,
      body: overrides.threadsStatus === undefined ? THREADS_OK : { message: 'rate limited' },
    })
    .install();
  return scenario;
}

describe('GithubPrDetail sub-query failures', () => {
  it('reports a failed checks read instead of rendering nothing', async () => {
    const scenario = scenarioWith({ checksStatus: 500 });
    try {
      render(<GithubPrDetail chatId={CHAT_ID} number={NUMBER} onBack={jest.fn()} />);
      await flushAsyncRender();

      expect(await screen.findByText('Checks could not be loaded.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      // The failure must not read as the "runs no checks" sentence beside it.
      expect(screen.queryByText('This pull request runs no checks.')).toBeNull();
    } finally {
      scenario.restore();
    }
  });

  it('reports a failed review-threads read instead of rendering nothing', async () => {
    const scenario = scenarioWith({ threadsStatus: 500 });
    try {
      render(<GithubPrDetail chatId={CHAT_ID} number={NUMBER} onBack={jest.fn()} />);
      await flushAsyncRender();

      expect(await screen.findByText('Review comments could not be loaded.')).toBeTruthy();
      expect(screen.queryByText('No review comments on this pull request.')).toBeNull();
    } finally {
      scenario.restore();
    }
  });
});
