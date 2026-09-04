/**
 * The vendor model and effort for the next send, scoped to one chat.
 *
 * Two values live here, and keeping them apart is the whole design:
 *
 * - **What the composer shows** is the session's own choice, falling back to
 *   what the chat durably stores. A model picked for a repository is expected
 *   back after a reload, and the turn header now names what actually ran, so a
 *   composer that forgot would disagree with the transcript above it.
 * - **What a send puts on the wire** is the session's choice *only*. The hub
 *   already resolves chat → per-target default on its own, so carrying a value
 *   nobody picked this session would create a second source of truth — and
 *   would pin a model the settings default was later changed away from.
 *
 * The wire field still exists, and this is what it is for: a send that races
 * the chat mutation runs as the composer showed rather than as the row happened
 * to read at that instant.
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
  const [scoped, setScoped] = useState<{
    readonly chatId: string | null;
    readonly request: ExternalTurnRequest;
  }>({ chatId: currentChatId, request: NO_EXTERNAL_TURN_REQUEST });

  const chosenThisSession =
    scoped.chatId === currentChatId ? scoped.request : NO_EXTERNAL_TURN_REQUEST;
  const stored = options.stored ?? NO_EXTERNAL_TURN_REQUEST;
  // Field by field rather than whole-object, so picking a model in a chat whose
  // stored effort is still valid keeps that effort on screen instead of
  // blanking it.
  const externalTurnRequest = hasChoice(chosenThisSession)
    ? {
        ...((chosenThisSession.model ?? stored.model)
          ? { model: chosenThisSession.model ?? stored.model }
          : {}),
        ...((chosenThisSession.effort ?? stored.effort)
          ? { effort: chosenThisSession.effort ?? stored.effort }
          : {}),
      }
    : stored;

  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;
  const persistRef = useRef(options.persist);
  persistRef.current = options.persist;
  const storedRef = useRef(stored);
  storedRef.current = stored;

  const setExternalTurnRequest = useCallback(
    (updater: (current: ExternalTurnRequest) => ExternalTurnRequest) => {
      const chatId = currentChatIdRef.current;
      setScoped((current) => ({
        chatId,
        request: updater(current.chatId === chatId ? current.request : NO_EXTERNAL_TURN_REQUEST),
      }));
      if (!chatId) return;
      // Read back through the same merge the render uses, so the row is written
      // with the pair the composer is about to show. Written together for the
      // reason the repository writes them together: an effort belongs to the
      // model it was chosen for.
      const next = updater(scoped.chatId === chatId ? scoped.request : NO_EXTERNAL_TURN_REQUEST);
      const merged = storedRef.current;
      persistRef.current?.({
        ...((next.model ?? merged.model) ? { model: next.model ?? merged.model } : {}),
        ...((next.effort ?? merged.effort) ? { effort: next.effort ?? merged.effort } : {}),
      });
    },
    [scoped]
  );

  const requestRef = useRef(chosenThisSession);
  requestRef.current = chosenThisSession;
  const getExternalTurnRequest = useCallback(() => {
    const request = requestRef.current;
    if (!hasChoice(request)) return undefined;
    const merged = storedRef.current;
    return {
      ...((request.model ?? merged.model) ? { model: request.model ?? merged.model } : {}),
      ...((request.effort ?? merged.effort) ? { effort: request.effort ?? merged.effort } : {}),
    };
  }, []);

  return { externalTurnRequest, setExternalTurnRequest, getExternalTurnRequest };
}

function hasChoice(request: ExternalTurnRequest): boolean {
  return request.model !== undefined || request.effort !== undefined;
}
