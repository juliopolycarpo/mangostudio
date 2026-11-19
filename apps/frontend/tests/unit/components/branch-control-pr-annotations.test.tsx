/**
 * The branch menu's pull request tags read `gh pr list --state=all`, which is a
 * live subprocess on the runtime plus a round trip to a rate-limited API. The
 * Repository panel mounts this control on every chat, so reading eagerly spent
 * that call on a closed dropdown nobody had asked to see.
 */

import { describe, expect, it } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';

import { BranchControl } from '../../../src/features/workspace/BranchControl';
import { render, screen, waitFor } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const CHAT_ID = 'chat-1';
const PRS_PATH = `/api/github/prs?chatId=${CHAT_ID}&filter=all`;

const mergedPullRequest = {
  number: 7,
  title: 'Add the panel',
  state: 'MERGED',
  isDraft: false,
  url: 'https://github.com/mango/studio/pull/7',
  headRefName: 'feat/panel',
  baseRefName: 'main',
  updatedAt: '2026-08-20T10:00:00Z',
  author: { login: 'octocat' },
  labels: [],
  reviewDecision: null,
  checks: { passed: 0, failed: 0, pending: 0, total: 0 },
};

/** The URL a `fetch` call asked for; Eden passes a `Request`, a `URL` or a string. */
function requestedUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

/** Requests the scenario's fetch received whose URL contains `fragment`. */
function requestsTo(
  scenario: ReturnType<typeof createFetchScenario>,
  fragment: string
): readonly unknown[] {
  return scenario.fetchMock.mock.calls.filter(([input]) => requestedUrl(input).includes(fragment));
}

describe('BranchControl pull request tags', () => {
  it('does not list pull requests until the branch menu is opened', async () => {
    const user = userEvent.setup();
    const scenario = createFetchScenario()
      .respondWithJson('GET', `/api/git/branches?chatId=${CHAT_ID}`, {
        body: {
          branches: [
            { name: 'main', current: true, ahead: 0, behind: 0 },
            { name: 'feat/panel', current: false, ahead: 0, behind: 0 },
          ],
          remotes: [],
        },
      })
      .respondWithJson('GET', PRS_PATH, {
        body: {
          state: 'ok',
          cachedAt: 1,
          repo: { nameWithOwner: 'mango/studio', defaultBranch: 'main', url: '' },
          prs: [mergedPullRequest],
        },
      })
      .install();

    try {
      render(
        <BranchControl
          chatId={CHAT_ID}
          branch={{ name: 'main', ahead: 0, behind: 0 }}
          detachedLabel="detached"
        />
      );

      // The branch list itself is cheap and loads on mount; wait for it so the
      // assertion below runs after every eager request had its chance to fire.
      await waitFor(() => expect(requestsTo(scenario, '/git/branches')).toHaveLength(1));
      await Promise.resolve();
      expect(requestsTo(scenario, '/github/prs')).toHaveLength(0);

      await user.click(screen.getByLabelText(en.git.branch.menu));

      await waitFor(() => expect(requestsTo(scenario, '/github/prs')).toHaveLength(1));
      expect(await screen.findByText(/#7 · /)).toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });
});
