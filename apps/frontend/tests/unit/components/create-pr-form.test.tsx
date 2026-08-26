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
});
