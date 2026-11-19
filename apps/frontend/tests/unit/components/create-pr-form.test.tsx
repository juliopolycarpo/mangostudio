/**
 * The create-pull-request form's Cancel button while a submission is in
 * flight.
 *
 * `onDone` only closes the form — it does not abort the push or the create
 * request — so an enabled Cancel during submission let a pull request appear
 * moments after the form it was made in had already vanished, with no visible
 * pending state or result in between.
 */

import { describe, expect, it, jest } from 'bun:test';

import userEvent from '@testing-library/user-event';

import { CreatePrForm } from '../../../src/features/github/components/CreatePrForm';
import { render, screen } from '../../support/harness/render';
import { createFetchScenario } from '../../support/mocks/create-fetch-scenario';

const CHAT_ID = 'chat-1';

describe('CreatePrForm', () => {
  it('disables Cancel while the create request is in flight', async () => {
    const user = userEvent.setup();
    let releaseCreate: (() => void) | undefined;
    const scenario = createFetchScenario().install();
    scenario.fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = () =>
            resolve(
              new Response(
                JSON.stringify({
                  state: 'ok',
                  repo: { nameWithOwner: 'mango/studio', defaultBranch: 'main', url: '' },
                  pr: {
                    number: 7,
                    title: 'Fix the rail',
                    url: '',
                    state: 'OPEN',
                    isDraft: false,
                    headRefName: 'feat/rail',
                    baseRefName: 'main',
                    updatedAt: '2026-08-20T10:00:00Z',
                    author: { id: 'x', is_bot: false, login: 'octocat' },
                    labels: [],
                    reviewDecision: '',
                    statusCheckRollup: [],
                  },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              )
            );
        })
    );

    try {
      const onDone = jest.fn();
      render(
        <CreatePrForm
          chatId={CHAT_ID}
          needsPush={false}
          defaultTitle="Fix the rail"
          onDone={onDone}
        />
      );

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      expect(cancelButton).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'Create pull request' }));

      expect(cancelButton).toBeDisabled();
      expect(onDone).not.toHaveBeenCalled();

      releaseCreate?.();
      await screen.findByText(/Pull request #7 created\.?/);

      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      scenario.restore();
    }
  });

  /**
   * The pull request exists but its read-back failed. Leaving the form mounted
   * with the title and body intact invited a second submit, which opens a
   * duplicate pull request for the same branch.
   */
  it('replaces the form with a link when the pull request was created but could not be read', async () => {
    const user = userEvent.setup();
    const scenario = createFetchScenario().install();
    scenario.fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            state: 'created-unreadable',
            url: 'https://github.com/mango/studio/pull/7',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    try {
      const onDone = jest.fn();
      render(
        <CreatePrForm
          chatId={CHAT_ID}
          needsPush={false}
          defaultTitle="Fix the rail"
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: 'Create pull request' }));

      const link = await screen.findByRole('link', { name: 'Open on GitHub' });
      expect(link).toHaveAttribute('href', 'https://github.com/mango/studio/pull/7');
      expect(screen.getByText(/created, but .* could not be read/i)).toBeInTheDocument();
      // Nothing left to submit: the draft and the button that would duplicate it are gone.
      expect(screen.queryByRole('button', { name: 'Create pull request' })).toBeNull();
      expect(screen.queryByDisplayValue('Fix the rail')).toBeNull();
      // Closing is the user's call, so the pull request link stays on screen until then.
      expect(onDone).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      scenario.restore();
    }
  });

  it('offers no link when the created pull request has no known URL', async () => {
    const user = userEvent.setup();
    const scenario = createFetchScenario().install();
    scenario.fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ state: 'created-unreadable', url: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    try {
      render(
        <CreatePrForm
          chatId={CHAT_ID}
          needsPush={false}
          defaultTitle="Fix the rail"
          onDone={jest.fn()}
        />
      );

      await user.click(screen.getByRole('button', { name: 'Create pull request' }));

      await screen.findByText(/created, but .* could not be read/i);
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Create pull request' })).toBeNull();
    } finally {
      scenario.restore();
    }
  });
});
