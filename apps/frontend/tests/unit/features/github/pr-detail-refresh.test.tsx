/**
 * The pull request detail view's own refresh control.
 *
 * The section header's refresh button re-reads the list behind the open tab,
 * so before this control a person watching a pull request's checks only saw new
 * results once the API's 60 second cache entry expired. The control has to
 * reach GitHub for all three reads the view runs, not just the one it shows
 * the staleness of.
 */

import { describe, expect, it, jest } from 'bun:test';

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GithubPrDetail } from '../../../../src/features/github/components/GithubPrDetail';
import { flushAsyncRender, render } from '../../../support/harness/render';
import { createFetchScenario } from '../../../support/mocks/create-fetch-scenario';

const CHAT_ID = 'chat-1';
const NUMBER = 942;

const DETAIL_PATH = `/api/github/pr?chatId=${CHAT_ID}&number=${NUMBER}`;
const CHECKS_PATH = `/api/github/pr/checks?chatId=${CHAT_ID}&number=${NUMBER}`;
const THREADS_PATH = `/api/github/pr/review-threads?chatId=${CHAT_ID}&number=${NUMBER}`;
const FORCED = '&refresh=true';

const REPO = { nameWithOwner: 'mango/studio' };

function detailBody(cachedAt: number) {
  return {
    state: 'ok',
    cachedAt,
    repo: REPO,
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
}

function checksBody(cachedAt: number, name: string) {
  return {
    state: 'ok',
    cachedAt,
    repo: REPO,
    summary: { passed: 1, failed: 0, pending: 0, total: 1 },
    checks: [{ name, bucket: 'pass', state: 'SUCCESS', link: '', workflow: 'CI' }],
  };
}

const THREADS_BODY = { state: 'ok', cachedAt: 1_000, repo: REPO, threads: [], truncated: false };

/** Plain reads answer with the old checks; the `refresh=true` ones with a newer run. */
function scenarioWithCachedAndFreshReads() {
  const scenario = createFetchScenario();
  scenario
    .respondWithJson('GET', DETAIL_PATH, { body: detailBody(1_000) })
    .respondWithJson('GET', CHECKS_PATH, { body: checksBody(1_000, 'build (cached)') })
    .respondWithJson('GET', THREADS_PATH, { body: THREADS_BODY })
    .respondWithJson('GET', DETAIL_PATH + FORCED, { body: detailBody(2_000) })
    .respondWithJson('GET', CHECKS_PATH + FORCED, { body: checksBody(2_000, 'build (fresh)') })
    .respondWithJson('GET', THREADS_PATH + FORCED, { body: THREADS_BODY })
    .install();
  return scenario;
}

function requestedPaths(scenario: ReturnType<typeof createFetchScenario>): string[] {
  return scenario.fetchMock.mock.calls.map(([input]) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    return `${url.pathname}${url.search}`;
  });
}

describe('GithubPrDetail refresh', () => {
  it('re-reads the detail, checks and review threads past the cache when refreshed', async () => {
    const scenario = scenarioWithCachedAndFreshReads();
    const user = userEvent.setup();
    try {
      render(<GithubPrDetail chatId={CHAT_ID} number={NUMBER} onBack={jest.fn()} />);
      await flushAsyncRender();
      expect(await screen.findByText('build (cached)')).toBeTruthy();
      expect(
        requestedPaths(scenario).filter((path) => path.includes('refresh')),
        'requests carrying refresh before the control was pressed'
      ).toEqual([]);

      const detail = within(screen.getByTestId('github-pr-detail'));
      await user.click(detail.getByRole('button', { name: 'Refresh' }));

      expect(await screen.findByText('build (fresh)')).toBeTruthy();
      expect(requestedPaths(scenario)).toEqual(
        expect.arrayContaining([DETAIL_PATH + FORCED, CHECKS_PATH + FORCED, THREADS_PATH + FORCED])
      );
    } finally {
      scenario.restore();
    }
  });

  it('shows when the detail was read beside the refresh control', async () => {
    const scenario = scenarioWithCachedAndFreshReads();
    try {
      render(<GithubPrDetail chatId={CHAT_ID} number={NUMBER} onBack={jest.fn()} />);
      await flushAsyncRender();

      const detail = within(await screen.findByTestId('github-pr-detail'));
      expect(await detail.findByText(/^Updated /)).toBeTruthy();
      expect(detail.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    } finally {
      scenario.restore();
    }
  });

  it('sends no refresh on the reads the view makes when it mounts', async () => {
    const scenario = scenarioWithCachedAndFreshReads();
    try {
      render(<GithubPrDetail chatId={CHAT_ID} number={NUMBER} onBack={jest.fn()} />);
      await flushAsyncRender();
      expect(await screen.findByText('build (cached)')).toBeTruthy();

      expect(requestedPaths(scenario).sort()).toEqual(
        [CHECKS_PATH, DETAIL_PATH, THREADS_PATH].sort()
      );
    } finally {
      scenario.restore();
    }
  });
});
