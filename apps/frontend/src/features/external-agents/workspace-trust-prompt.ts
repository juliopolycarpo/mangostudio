/**
 * A promise-shaped bridge between the send path and the trust dialog.
 *
 * The refusal arrives in the middle of a send: the server answers 403 before a
 * byte of the stream, so the composer has already cleared and the optimistic
 * messages are already on screen. Asking the user to type their prompt again
 * would be the wrong price for a decision they were never offered — so the send
 * awaits an answer here and retries once, and the dialog only has to resolve a
 * boolean.
 *
 * Deliberately not a React context. The asker is a hook deep in the generation
 * path and the renderer is a component in the authenticated layout; a context
 * would make every caller thread a prop through for one dialog that exists at
 * most once at a time. A single pending request is enough for the same reason:
 * a chat runs one turn.
 */

export interface ExternalWorkspaceTrustRequest {
  readonly chatId: string;
  /** The canonical directory the vendor will read, as the server spelled it. */
  readonly workspacePath: string;
  /**
   * The rest of the scope the grant would cover, as the refusal disclosed it.
   *
   * The dialog prints the path, but the grant is keyed on the vendor and the
   * machine too. Carrying them means the answer can be checked against the
   * question that was asked rather than against whatever the chat says by the
   * time the user clicks.
   */
  readonly targetId: string;
  readonly environmentId: string;
}

interface PendingPrompt extends ExternalWorkspaceTrustRequest {
  readonly settle: (granted: boolean) => void;
}

type Listener = (pending: ExternalWorkspaceTrustRequest | null) => void;

let pending: PendingPrompt | null = null;
const listeners = new Set<Listener>();

/** The request without the resolver, which is nobody else's to hold. */
function snapshot(): ExternalWorkspaceTrustRequest | null {
  if (!pending) return null;
  const { settle: _settle, ...request } = pending;
  return request;
}

function publish(): void {
  const current = snapshot();
  for (const listener of [...listeners]) listener(current);
}

/**
 * Asks the user to trust a workspace, resolving `true` only once the grant is
 * recorded.
 *
 * A second request while one is open resolves `false` rather than queueing: the
 * dialog is modal and the send that raised it is already waiting, so a queue
 * would hold a turn open behind a decision about a different one.
 */
export function promptExternalWorkspaceTrust(
  request: ExternalWorkspaceTrustRequest
): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = {
      ...request,
      settle: (granted) => {
        pending = null;
        publish();
        resolve(granted);
      },
    };
    publish();
  });
}

/**
 * Subscribes the dialog. Returns the unsubscribe.
 *
 * Losing the last subscriber settles the open request as declined, because at
 * that point nobody can answer it. This module outlives every component that
 * uses it, and the one that unmounts it is the authenticated layout: when a
 * session expires mid-dialog, a surviving `pending` would be handed straight to
 * the next account's gate on sign-in — showing them the previous user's chat id
 * and absolute workspace path, in a dialog whose grant could only fail against
 * their credentials. Declining is also the right answer for the send still
 * awaiting it: it re-throws the refusal instead of hanging forever.
 */
export function onExternalWorkspaceTrustPrompt(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) settleExternalWorkspaceTrust(false);
  };
}

/** Answers the open prompt. A no-op when nothing is waiting. */
export function settleExternalWorkspaceTrust(granted: boolean): void {
  pending?.settle(granted);
}
