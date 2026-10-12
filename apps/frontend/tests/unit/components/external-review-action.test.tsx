/**
 * The review action is absent unless the chat can actually be reviewed, and it
 * never reads as the permissions dropdown's "Auto-review".
 *
 * Both properties are the point of the feature rather than polish: an action
 * offered on a runner that has no review surface fails after the user commits
 * to it, and copy that does not name its subject leaves someone believing they
 * asked for a code review when they enabled unattended approvals.
 */

import { describe, expect, it, jest, mock } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { AppContext } from '../../../src/lib/app-context';
import { ExternalRefusalError } from '../../../src/lib/external-refusal-error';
import { ApiError } from '../../../src/lib/utils';
import { render, screen, waitFor } from '../../support/harness/render';

const descriptors: ExternalAgentDescriptor[] = [];

mock.module('../../../src/features/external-agents/useExternalAgents', () => ({
  useExternalAgents: () => ({
    agents: descriptors,
    isLoading: false,
    find: (targetId: string) => descriptors.find((agent) => agent.targetId === targetId),
  }),
}));

// After the mock, never before: a static import is evaluated first and would
// bind the action to the real useExternalAgents hook.
const { ExternalReviewAction } = await import(
  '../../../src/features/external-agents/ExternalReviewAction'
);

function descriptor(nativeReview: boolean): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: { ...NO_EXTERNAL_AGENT_CAPABILITIES, nativeReview },
    supportedConfigurations: [],
  };
}

function renderAction(
  options: {
    readonly nativeReview?: boolean;
    readonly runner?: { kind: 'external'; targetId: 'codex' } | { kind: 'mangostudio' };
    readonly hasChanges?: boolean;
    readonly isGenerating?: boolean;
    readonly reviewFailure?: () => Error;
  } = {}
) {
  descriptors.length = 0;
  descriptors.push(descriptor(options.nativeReview ?? true));
  const handleReviewChanges = jest.fn(() => {
    const failure = options.reviewFailure?.();
    return failure ? Promise.reject(failure) : Promise.resolve();
  });
  const app = {
    runner: options.runner ?? { kind: 'external', targetId: 'codex' },
    currentChatId: 'chat-1',
    currentEnvironmentId: 'local',
    isGenerating: options.isGenerating ?? false,
    handleReviewChanges,
  };
  return {
    handleReviewChanges,
    ...render(
      <AppContext value={app as never}>
        <ExternalReviewAction chatId="chat-1" hasChanges={options.hasChanges ?? true} />
      </AppContext>
    ),
  };
}

describe('ExternalReviewAction', () => {
  it('offers the review, and says whose code it reviews', async () => {
    const { handleReviewChanges } = renderAction();

    const button = screen.getByRole('button', { name: en.externalAgents.review.button });
    // The disambiguation the permissions dropdown's "Auto-review" makes
    // necessary: same word, opposite subject.
    expect(
      screen.getByText(
        en.externalAgents.review.hint.replace('{vendor}', en.externalAgents.target.codex)
      )
    ).toBeTruthy();

    await userEvent.setup().click(button);
    expect(handleReviewChanges).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a runner with no review surface', () => {
    renderAction({ nativeReview: false });
    expect(screen.queryByRole('button', { name: en.externalAgents.review.button })).toBeNull();
  });

  it('renders nothing for a MangoStudio chat', () => {
    renderAction({ runner: { kind: 'mangostudio' } });
    expect(screen.queryByRole('button', { name: en.externalAgents.review.button })).toBeNull();
  });

  it('stays visible on a clean tree and says there is nothing to review', () => {
    // Disabled rather than absent: the action exists for this chat, and hiding
    // it would read as the agent having lost the ability to review.
    renderAction({ hasChanges: false });

    const button = screen.getByRole('button', { name: en.externalAgents.review.button });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(en.externalAgents.review.noChanges)).toBeTruthy();
  });

  it('reports a refused review in the panel the user clicked in, localized', async () => {
    // The transcript carries the server's own sentence; this is the copy for
    // the repository panel, and the code is the server's decision rather than
    // something the component guessed.
    renderAction({
      reviewFailure: () =>
        new ApiError({
          error: 'This folder is not a Git repository, so there are no changes to review.',
          code: ERROR_CODES.EXTERNAL_REVIEW_REQUIRES_GIT,
        }),
    });

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: en.externalAgents.review.button }));

    expect(await screen.findByText(en.externalAgents.review.requiresGit)).toBeTruthy();
  });

  describe('a review the hub refused for a state of the agent', () => {
    const SENTENCE = 'The external agent turn could not be started.';

    /** The text of the toast the click raises: the only thing on screen beyond the panel's own copy. */
    async function toastAfter(failure: () => Error): Promise<string> {
      const { container } = renderAction({ reviewFailure: failure });
      const panelText = container.textContent ?? '';
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: en.externalAgents.review.button }));
      await waitFor(() => expect(document.body.textContent).not.toBe(panelText));
      return (document.body.textContent ?? '').replace(panelText, '');
    }

    it('says signed out with the command to run, not the generic sentence', async () => {
      const text = await toastAfter(
        () =>
          new ExternalRefusalError({
            error: SENTENCE,
            unavailableReason: 'signed-out',
            remedy: { kind: 'sign-in', command: 'codex login' },
          })
      );

      expect(text).toBe(`${en.externalAgents.unavailable['signed-out']}: codex login`);
    });

    it('says not installed with the install action', async () => {
      const text = await toastAfter(
        () =>
          new ExternalRefusalError({
            error: SENTENCE,
            unavailableReason: 'not-installed',
            remedy: { kind: 'install' },
          })
      );

      expect(text).toBe(
        `${en.externalAgents.unavailable['not-installed']}: ${en.externalAgents.remedy.install}`
      );
    });

    it('names the build an outdated agent needs, keeping a hostile version literal', async () => {
      const hostile = '<img src=x onerror=alert(1)> $&';
      const text = await toastAfter(
        () =>
          new ExternalRefusalError({
            error: SENTENCE,
            unavailableReason: 'version-unsupported',
            remedy: { kind: 'update' },
            requiredVersion: hostile,
          })
      );

      expect(text).toBe(
        `${en.externalAgents.unavailable['version-unsupported'].replace('{version}', () => hostile)}: ${en.externalAgents.remedy.update}`
      );
      expect(document.querySelectorAll('img').length).toBe(0);
    });

    it('says the session cap in plain words', async () => {
      const text = await toastAfter(
        () => new ApiError({ error: SENTENCE, code: 'external_agent_capacity' })
      );

      expect(text).toBe(en.externalAgents.openFailure.capacity);
    });

    it('keeps the sentence for a failed open and adds the runtime kind to quote to support', async () => {
      const text = await toastAfter(
        () => new ApiError({ error: SENTENCE, code: 'external_agent_launch_failed' })
      );

      expect(text).toBe(`${SENTENCE} (external_agent_launch_failed)`);
    });

    it('falls back to the server sentence for a refusal that names nothing, as an older hub sends it', async () => {
      const text = await toastAfter(() => new ApiError({ error: SENTENCE }));

      expect(text).toBe(SENTENCE);
    });
  });

  it('cannot start a second turn while one is running', () => {
    renderAction({ isGenerating: true });
    const button = screen.getByRole('button', { name: en.externalAgents.review.button });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
