/**
 * The bridge between a refused send and the trust dialog.
 *
 * Module state that outlives every component touching it, which is the whole
 * reason these cases exist: a request left behind by one session is a request
 * the next one inherits.
 */

import { describe, expect, it } from 'vitest';
import {
  type ExternalWorkspaceTrustRequest,
  onExternalWorkspaceTrustPrompt,
  promptExternalWorkspaceTrust,
  settleExternalWorkspaceTrust,
} from '@/features/external-agents/workspace-trust-prompt';

const request = { chatId: 'chat-1', workspacePath: '/home/someone/repo' };

describe('workspace trust prompt', () => {
  it('publishes the open request to a subscriber and resolves on the answer', async () => {
    const seen: Array<ExternalWorkspaceTrustRequest | null> = [];
    const unsubscribe = onExternalWorkspaceTrustPrompt((pending) => seen.push(pending));

    const answer = promptExternalWorkspaceTrust(request);
    expect(seen.at(-1)).toEqual(request);

    settleExternalWorkspaceTrust(true);
    expect(await answer).toBe(true);
    expect(seen.at(-1)).toBeNull();
    unsubscribe();
  });

  it('declines the open request when the last subscriber goes away', async () => {
    // What a session expiring mid-dialog looks like: the authenticated layout
    // unmounts, so nothing can render or answer the prompt any more.
    const unsubscribe = onExternalWorkspaceTrustPrompt(() => undefined);
    const answer = promptExternalWorkspaceTrust(request);

    unsubscribe();
    expect(await answer).toBe(false);
  });

  it('does not hand a request left by one session to the next', async () => {
    const unsubscribe = onExternalWorkspaceTrustPrompt(() => undefined);
    const answer = promptExternalWorkspaceTrust(request);
    unsubscribe();
    await answer;

    // The next account's gate mounts. It must be told there is nothing to show,
    // rather than the previous user's chat id and absolute workspace path.
    const seen: Array<ExternalWorkspaceTrustRequest | null> = [];
    const resubscribe = onExternalWorkspaceTrustPrompt((pending) => seen.push(pending));
    expect(seen).toEqual([null]);
    resubscribe();
  });

  it('keeps the request open while another subscriber remains', () => {
    const first = onExternalWorkspaceTrustPrompt(() => undefined);
    const seen: Array<ExternalWorkspaceTrustRequest | null> = [];
    const second = onExternalWorkspaceTrustPrompt((pending) => seen.push(pending));

    void promptExternalWorkspaceTrust(request);
    first();
    expect(seen.at(-1)).toEqual(request);

    second();
  });
});
