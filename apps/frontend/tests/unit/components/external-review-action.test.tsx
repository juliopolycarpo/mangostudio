/**
 * The review action is absent unless the chat can actually be reviewed, and it
 * never reads as the permissions dropdown's "Auto-review".
 *
 * Both properties are the point of the feature rather than polish: an action
 * offered on a runner that has no review surface fails after the user commits
 * to it, and copy that does not name its subject leaves someone believing they
 * asked for a code review when they enabled unattended approvals.
 */

import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ExternalReviewAction } from '../../../src/features/external-agents/ExternalReviewAction';
import { AppContext } from '../../../src/lib/app-context';
import { render, screen } from '../../support/harness/render';

const descriptors: ExternalAgentDescriptor[] = [];

vi.mock('../../../src/features/external-agents/useExternalAgents', () => ({
  useExternalAgents: () => ({
    agents: descriptors,
    isLoading: false,
    find: (targetId: string) => descriptors.find((agent) => agent.targetId === targetId),
  }),
}));

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
  } = {}
) {
  descriptors.length = 0;
  descriptors.push(descriptor(options.nativeReview ?? true));
  const handleReviewChanges = vi.fn(() => Promise.resolve());
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

  it('cannot start a second turn while one is running', () => {
    renderAction({ isGenerating: true });
    const button = screen.getByRole('button', { name: en.externalAgents.review.button });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
