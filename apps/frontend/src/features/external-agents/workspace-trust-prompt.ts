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
}

interface PendingPrompt extends ExternalWorkspaceTrustRequest {
  readonly settle: (granted: boolean) => void;
}

type Listener = (pending: ExternalWorkspaceTrustRequest | null) => void;

let pending: PendingPrompt | null = null;
const listeners = new Set<Listener>();

function publish(): void {
  const snapshot = pending
    ? { chatId: pending.chatId, workspacePath: pending.workspacePath }
    : null;
  for (const listener of [...listeners]) listener(snapshot);
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

/** Subscribes the dialog. Returns the unsubscribe. */
export function onExternalWorkspaceTrustPrompt(listener: Listener): () => void {
  listeners.add(listener);
  listener(pending ? { chatId: pending.chatId, workspacePath: pending.workspacePath } : null);
  return () => listeners.delete(listener);
}

/** Answers the open prompt. A no-op when nothing is waiting. */
export function settleExternalWorkspaceTrust(granted: boolean): void {
  pending?.settle(granted);
}
