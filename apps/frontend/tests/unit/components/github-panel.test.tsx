/**
 * The GitHub rail panel across every state its data can be in.
 *
 * The degradation matrix is the point. Four of the six states here are 200s
 * carrying a `state` rather than errors — a checkout with no GitHub remote is a
 * successful read of a repository that has nothing to say — and the panel has
 * exactly one renderer for all four. A test per state is how that stays true:
 * the first time the pull request list grows a fifth explanation the inbox does
 * not have, somebody who is simply logged out gets two different sentences
 * depending on which half of the panel they are looking at.
 */

import { describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { GithubPanel } from '../../../src/features/github/components/GithubPanel';
import { requestGithubCreatePr } from '../../../src/features/github/lib/github-panel-request';
import { act, flushAsyncRender } from '../../support/harness/render';
import { renderWithRouter } from '../../support/harness/render-with-router';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const CHAT_ID = 'chat-1';
const WORKDIR = '/srv/projects/mango';

const REPO = {
  nameWithOwner: 'mango/studio',
  defaultBranch: 'main',
  url: 'https://github.com/mango/studio',
};

const PR = {
  number: 942,
  title: 'Build the GitHub rail panel',
  url: 'https://github.com/mango/studio/pull/942',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/github-panel',
  baseRefName: 'main',
  updatedAt: '2026-08-25T00:00:00Z',
  author: { login: 'alice' },
  labels: [],
  reviewDecision: null,
  checks: { passed: 3, failed: 1, pending: 0, total: 4 },
};

const INBOX_ITEM = {
  number: 17,
  title: 'Tighten the runtime probe cache',
  url: 'https://github.com/mango/runtime/pull/17',
  state: 'OPEN',
  isDraft: false,
  updatedAt: '2026-08-25T00:00:00Z',
  author: { login: 'bob' },
  labels: [],
  repository: { nameWithOwner: 'mango/runtime' },
};

/** A repository the chat is bound to, so the "This repo" half has something to be about. */
const GIT_REPO_STATE = {
  state: 'repo',
  workdir: WORKDIR,
  root: WORKDIR,
  status: {
    branch: {
      name: 'feat/github-panel',
      upstream: 'origin/feat/github-panel',
      ahead: 0,
      behind: 0,
    },
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: true,
  },
};

interface ScenarioOverrides {
  readonly inbox?: unknown;
  readonly prs?: unknown;
  readonly gitState?: unknown;
}

function installScenario(overrides: ScenarioOverrides = {}) {
  return createFetchScenario()
    .respondWithJson('GET', `/api/git/state?chatId=${CHAT_ID}`, {
      body: overrides.gitState ?? GIT_REPO_STATE,
    })
    .respondWithJson('GET', '/api/github/inbox', {
      body: overrides.inbox ?? { state: 'ok', cachedAt: Date.now(), items: [] },
    })
    .respondWithJson('GET', `/api/github/prs?chatId=${CHAT_ID}&filter=open`, {
      body: overrides.prs ?? { state: 'ok', cachedAt: Date.now(), repo: REPO, prs: [] },
    })
    .install();
}

async function renderPanel(overrides: ScenarioOverrides = {}, workdir: string | null = WORKDIR) {
  const scenario = installScenario(overrides);
  const result = await renderWithRouter(<GithubPanel chatId={CHAT_ID} workdir={workdir} />);
  // Both sections answer after the first paint, and each answer is a React
  // state update; settling them here keeps the act warnings out of whichever
  // file the runner happens to be on when they land.
  await flushAsyncRender();
  return { ...result, scenario };
}

describe('GithubPanel', () => {
  it('shows a loading state, not a skeleton, while the reads are in flight', async () => {
    const scenario = installScenario();
    try {
      // Rendered but deliberately not flushed: this is the only point at which
      // the in-flight state is observable. Rail panels use `EmptyState` for
      // loading rather than skeleton lines — `HubSkeletonLines` belongs to the
      // home hub, and importing it here would be a cross-feature reach.
      await renderWithRouter(<GithubPanel chatId={CHAT_ID} workdir={WORKDIR} />);
      expect(screen.getAllByText('Reading GitHub context...').length).toBeGreaterThan(0);
      await flushAsyncRender();
    } finally {
      scenario.restore();
    }
  });

  it('renders both sections so the rail always has a shape', async () => {
    const { scenario } = await renderPanel();
    try {
      expect(screen.getByTestId('github-panel')).toBeInTheDocument();
      expect(screen.getByTestId('github-inbox-section')).toBeVisible();
      expect(screen.getByTestId('github-repo-section')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  it('says the chat has no folder rather than asking GitHub about one', async () => {
    // The one deterministic state on this panel: with no workdir there is no
    // repository, whatever `gh` would have answered.
    const { scenario } = await renderPanel({}, null);
    try {
      expect(
        await screen.findByText('Point this chat at a folder to see its pull requests and issues.')
      ).toBeVisible();
      // And the inbox is still there, because a review queue is not repo-scoped.
      expect(screen.getByTestId('github-inbox-section')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  it('lists pull requests with their check state', async () => {
    const { scenario } = await renderPanel({
      prs: { state: 'ok', cachedAt: Date.now(), repo: REPO, prs: [PR] },
    });
    try {
      expect(await screen.findByText('Build the GitHub rail panel')).toBeVisible();
      expect(screen.getByText('#942')).toBeVisible();
      // One failed check outranks three passing ones.
      expect(screen.getByText('checks failing')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  it('lists the cross-repo review queue with the repository each row belongs to', async () => {
    const { scenario } = await renderPanel({
      inbox: { state: 'ok', cachedAt: Date.now(), items: [INBOX_ITEM] },
    });
    try {
      expect(await screen.findByText('Tighten the runtime probe cache')).toBeVisible();
      expect(screen.getByText('mango/runtime #17')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  it('reports an empty review queue rather than an empty list', async () => {
    const { scenario } = await renderPanel();
    try {
      expect(await screen.findByText('Nothing is waiting on your review.')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  it('reports no matching pull requests under the active filter', async () => {
    const { scenario } = await renderPanel();
    try {
      expect(await screen.findByText('No pull requests match this filter.')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  // The four not-ok states, each on both halves of the panel: they are a shared
  // union in the contract precisely so both render the same sentence.
  const UNAVAILABLE = [
    ['gh-not-installed', 'GitHub CLI is not installed where this chat runs.'],
    ['not-authenticated', 'GitHub CLI is not signed in where this chat runs.'],
    ['no-remote', 'This repository has no remote.'],
    ['not-a-github-remote', 'This repository does not have a GitHub remote.'],
  ] as const;

  for (const [state, sentence] of UNAVAILABLE) {
    it(`explains ${state} on the repository section`, async () => {
      const { scenario } = await renderPanel({ prs: { state } });
      try {
        expect(await screen.findByText(sentence)).toBeVisible();
      } finally {
        scenario.restore();
      }
    });

    it(`explains ${state} on the review queue`, async () => {
      const { scenario } = await renderPanel({ inbox: { state } });
      try {
        expect(await screen.findByText(sentence)).toBeVisible();
      } finally {
        scenario.restore();
      }
    });
  }

  it('degrades each section on its own when a read fails', async () => {
    const { scenario } = await renderPanel({ inbox: undefined, prs: { state: 'no-remote' } });
    try {
      // The repository half explains itself while the inbox still lists nothing
      // waiting — neither section is a reason to blank the other.
      expect(await screen.findByText('This repository has no remote.')).toBeVisible();
      expect(screen.getByText('Nothing is waiting on your review.')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  /**
   * The command palette's "Create pull request" row reaches the panel through
   * this same channel. It has to open the form itself, not just the panel —
   * otherwise the row runs the same generic "open the panel" affordance a
   * sibling row already offers, under a label that promises more.
   */
  it('opens the create-pull-request form on a create-pr request', async () => {
    const { scenario } = await renderPanel();
    try {
      expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();

      act(() => {
        requestGithubCreatePr();
      });

      expect(await screen.findByLabelText('Title')).toBeVisible();
    } finally {
      scenario.restore();
    }
  });

  /**
   * A detached checkout has no branch for `readCurrentBranch()` to name, and
   * `gh pr create` needs one to push. Offering the button anyway means a form
   * fully filled out fails with a generic server error instead of never
   * appearing in the first place.
   */
  it('explains rather than offers pull request creation on a detached checkout', async () => {
    const { scenario } = await renderPanel({
      gitState: {
        ...GIT_REPO_STATE,
        status: {
          ...GIT_REPO_STATE.status,
          branch: { name: null, detachedAt: 'abc1234', ahead: 0, behind: 0 },
        },
      },
    });
    try {
      expect(await screen.findByText('Check out a branch to create a pull request.')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Create pull request' })).not.toBeInTheDocument();

      act(() => {
        requestGithubCreatePr();
      });

      expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    } finally {
      scenario.restore();
    }
  });
});
