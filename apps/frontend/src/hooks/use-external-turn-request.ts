/**
 * The vendor model and effort for the next send, scoped to one chat.
 *
 * Two values live here, and keeping them apart is the whole design:
 *
 * - **What the composer shows** is the session's own choice, falling back to
 *   what the chat durably stores *until this session picks something*. A model
 *   picked for a repository is expected back after a reload, and the turn
 *   header now names what actually ran, so a composer that forgot would
 *   disagree with the transcript above it.
 * - **What a send puts on the wire** is the session's choice *only*. The hub
 *   already resolves chat → per-target default on its own, so carrying a value
 *   nobody picked this session would create a second source of truth — and
 *   would pin a model the settings default was later changed away from.
 *
 * The wire field still exists, and this is what it is for: a send that races
 * the chat mutation runs as the composer showed rather than as the row happened
 * to read at that instant.
 *
 * **The session state is seeded from the stored pair on the first pick, and is
 * the whole pair from then on.** That is what makes a *clear* expressible: with
 * a per-field `?? stored` fallback there is no difference between "left alone"
 * and "set back to the vendor's default", so clearing a model re-read the
 * stored one and wrote it straight back. Seeding once and carrying the pair
 * means the absence of a field means absence.
 *
 * **Every pick is applied to the state the previous pick left.** The composer
 * changes both fields in one event — picking a model invalidates the effort
 * that belonged to the old one — and React does not re-render between the two
 * calls. Reading the render's copy of the state for the second call would apply
 * it to the pair from *before* the first, so the write that landed last was the
 * one that had never seen the model the user just chose.
 *
 * "Per-chat" is carried by storing the chat the choice was made in rather than
 * by an effect that clears on switch. The state lives for the whole
 * authenticated layout, so a single unscoped value would silently follow the
 * user into the next conversation, and a clearing effect would only catch up a
 * render later — after a send that raced it had already read the previous
 * chat's model. A choice whose chat is no longer the active one reads as no
 * choice at all.
 *
 * **Reading a default never writes one.** Persisting happens on an explicit
 * pick and nowhere else; if merely opening a chat wrote whatever the default
 * resolved to, every chat opened after setting one would silently adopt it, and
 * changing that default later would stop reaching them.
 */

import type { ChatRunnerModelSelection } from '@mangostudio/shared/chat';
import type { ExternalTurnRequest } from '@mangostudio/shared/generation';
import { useCallback, useRef, useState } from 'react';

/** Shared so a chat with no vendor choice keeps the same identity every render. */
const NO_EXTERNAL_TURN_REQUEST: ExternalTurnRequest = {};

/**
 * The session's own choice, and the chat it was made in.
 *
 * `touched` is not derivable from `request`: a session that cleared both fields
 * has chosen "the vendor's default", which is a choice, and reads identically
 * to a session that has chosen nothing at all.
 */
interface ScopedExternalTurnRequest {
  readonly chatId: string | null;
  readonly touched: boolean;
  readonly request: ExternalTurnRequest;
}

export interface ExternalTurnRequestOptions {
  /**
   * The durable selection to show when this session has chosen nothing — the
   * chat's own, already resolved against the per-target default by the caller.
   */
  readonly stored?: ChatRunnerModelSelection;
  /** Called with the whole pair on an explicit pick, never on a read. */
  readonly persist?: (selection: ChatRunnerModelSelection) => void;
}

export interface ExternalTurnRequestState {
  /** What the composer should show for the chat that is active now. */
  readonly externalTurnRequest: ExternalTurnRequest;
  readonly setExternalTurnRequest: (
    updater: (current: ExternalTurnRequest) => ExternalTurnRequest
  ) => void;
  /**
   * What the send path should put on the wire, or `undefined` for "the server
   * decides". Reads through a ref so it sees what is on screen now rather than
   * what was on screen when the callback was created.
   */
  readonly getExternalTurnRequest: () => ExternalTurnRequest | undefined;
}

export function useExternalTurnRequest(
  currentChatId: string | null,
  options: ExternalTurnRequestOptions = {}
): ExternalTurnRequestState {
  const [scoped, setScoped] = useState<ScopedExternalTurnRequest>({
    chatId: currentChatId,
    touched: false,
    request: NO_EXTERNAL_TURN_REQUEST,
  });

  const stored = options.stored ?? NO_EXTERNAL_TURN_REQUEST;
  const chosenThisSession = scoped.chatId === currentChatId && scoped.touched;
  const externalTurnRequest = chosenThisSession ? scoped.request : stored;

  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;
  const persistRef = useRef(options.persist);
  persistRef.current = options.persist;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  // The authoritative copy. `scoped` is a mirror that exists to re-render, and
  // it is a render behind for every pick after the first one in an event.
  const scopedRef = useRef(scoped);

  const setExternalTurnRequest = useCallback(
    (updater: (current: ExternalTurnRequest) => ExternalTurnRequest) => {
      const chatId = currentChatIdRef.current;
      const current = scopedRef.current;
      // Seeded from the stored pair on the first pick, so a model change lands
      // on the effort that is on screen rather than on an empty object — and so
      // the pair written below is the one the composer is about to show.
      const base =
        current.chatId === chatId && current.touched ? current.request : storedRef.current;
      const next = onlyChosen(updater(base));
      scopedRef.current = { chatId, touched: true, request: next };
      setScoped(scopedRef.current);
      if (!chatId) return;
      // Written as a pair for the reason the repository writes them as a pair:
      // an effort belongs to the model it was chosen for, so a model change
      // must never leave the previous model's effort behind it.
      persistRef.current?.(next);
    },
    []
  );

  const getExternalTurnRequest = useCallback(() => {
    const current = scopedRef.current;
    if (current.chatId !== currentChatIdRef.current || !current.touched) return undefined;
    return hasChoice(current.request) ? current.request : undefined;
  }, []);

  return { externalTurnRequest, setExternalTurnRequest, getExternalTurnRequest };
}

/**
 * The pair with unchosen fields removed.
 *
 * The composer clears a field by setting it to `undefined`, and a key holding
 * `undefined` survives a spread — so without this the persisted selection would
 * carry `{ effort: undefined }` and the wire shape would too.
 */
function onlyChosen(request: ExternalTurnRequest): ExternalTurnRequest {
  return {
    ...(request.model ? { model: request.model } : {}),
    ...(request.effort ? { effort: request.effort } : {}),
  };
}

function hasChoice(request: ExternalTurnRequest): boolean {
  return request.model !== undefined || request.effort !== undefined;
}
