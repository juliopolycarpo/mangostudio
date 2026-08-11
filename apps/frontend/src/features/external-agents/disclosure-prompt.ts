/**
 * A promise-shaped bridge between the send path and the third-party notice.
 *
 * The selector already shows this notice before a chat is pointed at a vendor,
 * so reaching here means the acknowledgement stopped being valid *after* that:
 * it was withdrawn from settings, or the vendor gained a capability that staled
 * it. Either way the refusal arrives mid-send — the server answers 403 before a
 * byte of the stream — so the composer has already cleared and the optimistic
 * messages are already on screen. Making the user retype the prompt would be the
 * wrong price for a decision nobody offered them.
 *
 * Deliberately the same shape as `workspace-trust-prompt`, for the same reasons:
 * not a React context, because the asker is a hook deep in the generation path
 * and the renderer is a component in the authenticated layout; one pending
 * request at a time, because a chat runs one turn.
 */

import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';

export interface ExternalDisclosureRequest {
  /**
   * Both fields, as the refusal disclosed them.
   *
   * The acknowledgement is stored per vendor *and* per machine, and the server
   * derives what is being acknowledged from the descriptor for this
   * environment. Carrying the environment means the answer is recorded against
   * the question that was asked rather than against whatever the app's current
   * environment happens to be by the time the user clicks.
   */
  readonly targetId: ExternalAgentTargetId;
  readonly environmentId: string;
}

interface PendingPrompt extends ExternalDisclosureRequest {
  readonly settle: (acknowledged: boolean) => void;
}

type Listener = (pending: ExternalDisclosureRequest | null) => void;

let pending: PendingPrompt | null = null;
const listeners = new Set<Listener>();

/** The request without the resolver, which is nobody else's to hold. */
function snapshot(): ExternalDisclosureRequest | null {
  if (!pending) return null;
  const { settle: _settle, ...request } = pending;
  return request;
}

function publish(): void {
  const current = snapshot();
  for (const listener of [...listeners]) listener(current);
}

/**
 * Shows the notice, resolving `true` only once the acknowledgement is stored.
 *
 * A second request while one is open resolves `false` rather than queueing: the
 * dialog is modal and the send that raised it is already waiting, so a queue
 * would hold a turn open behind a decision about a different one.
 */
export function promptExternalDisclosure(request: ExternalDisclosureRequest): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = {
      ...request,
      settle: (acknowledged) => {
        pending = null;
        publish();
        resolve(acknowledged);
      },
    };
    publish();
  });
}

/**
 * Subscribes the dialog. Returns the unsubscribe.
 *
 * Losing the last subscriber settles the open request as declined, because at
 * that point nobody can answer it. The component that unmounts this is the
 * authenticated layout: when a session expires mid-notice, a surviving `pending`
 * would be handed to the next account's gate on sign-in, offering them a
 * consent decision about the previous user's machine. Declining is also the
 * right answer for the send still awaiting it — it re-throws the refusal rather
 * than hanging forever.
 */
export function onExternalDisclosurePrompt(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) settleExternalDisclosure(false);
  };
}

/** Answers the open prompt. A no-op when nothing is waiting. */
export function settleExternalDisclosure(acknowledged: boolean): void {
  pending?.settle(acknowledged);
}
