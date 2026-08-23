/**
 * The bridge between a refused send and the third-party notice.
 *
 * Module state that outlives every component touching it, which is the whole
 * reason these cases exist: a request left behind by one session is a request
 * the next one inherits — and here that would offer a new account a consent
 * decision about the previous user's machine.
 */

import { describe, expect, it } from 'bun:test';
import {
  type ExternalDisclosureRequest,
  onExternalDisclosurePrompt,
  promptExternalDisclosure,
  settleExternalDisclosure,
} from '@/features/external-agents/disclosure-prompt';

const request: ExternalDisclosureRequest = { targetId: 'claude', environmentId: 'local' };

describe('external disclosure prompt', () => {
  it('publishes the open request to a subscriber and resolves on the answer', async () => {
    const seen: Array<ExternalDisclosureRequest | null> = [];
    const unsubscribe = onExternalDisclosurePrompt((pending) => seen.push(pending));

    const answer = promptExternalDisclosure(request);
    expect(seen.at(-1)).toEqual(request);

    settleExternalDisclosure(true);
    expect(await answer).toBe(true);
    expect(seen.at(-1)).toBeNull();
    unsubscribe();
  });

  /**
   * The send that raised the prompt is already waiting on it. Queueing a second
   * would hold that turn open behind a decision about a different one.
   */
  it('refuses a second request while one is open rather than queueing it', async () => {
    const unsubscribe = onExternalDisclosurePrompt(() => undefined);
    const first = promptExternalDisclosure(request);

    expect(await promptExternalDisclosure({ targetId: 'codex', environmentId: 'local' })).toBe(
      false
    );

    settleExternalDisclosure(true);
    expect(await first).toBe(true);
    unsubscribe();
  });

  it('declines the open request when the last subscriber goes away', async () => {
    // What a session expiring mid-notice looks like: the authenticated layout
    // unmounts, so nothing can render or answer the prompt any more. Declining
    // re-throws the refusal to the waiting send rather than hanging it forever.
    const unsubscribe = onExternalDisclosurePrompt(() => undefined);
    const answer = promptExternalDisclosure(request);

    unsubscribe();
    expect(await answer).toBe(false);
  });

  it('does not hand a request left by one session to the next', async () => {
    const unsubscribe = onExternalDisclosurePrompt(() => undefined);
    const answer = promptExternalDisclosure(request);
    unsubscribe();
    await answer;

    const seen: Array<ExternalDisclosureRequest | null> = [];
    const resubscribe = onExternalDisclosurePrompt((pending) => seen.push(pending));
    expect(seen).toEqual([null]);
    resubscribe();
  });

  it('keeps the request open while another subscriber remains', () => {
    const first = onExternalDisclosurePrompt(() => undefined);
    const seen: Array<ExternalDisclosureRequest | null> = [];
    const second = onExternalDisclosurePrompt((pending) => seen.push(pending));

    void promptExternalDisclosure(request);
    first();
    expect(seen.at(-1)).toEqual(request);

    settleExternalDisclosure(false);
    second();
  });
});
