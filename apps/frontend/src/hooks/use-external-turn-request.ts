/**
 * The vendor model and effort for the next send, scoped to one chat.
 *
 * Ephemeral, like the image intent: the durable choice is the permission pair,
 * which the chat persists. A model the user picked for one conversation should
 * not follow them into the next one, and the vendor's own default is the right
 * answer for a chat nobody has chosen one for.
 *
 * "Per-chat" is carried by storing the chat the choice was made in rather than
 * by an effect that clears on switch. The state lives for the whole
 * authenticated layout, so a single unscoped value would silently follow the
 * user into the next conversation, and a clearing effect would only catch up a
 * render later — after a send that raced it had already read the previous
 * chat's model. A choice whose chat is no longer the active one reads as no
 * choice at all.
 */

import type { ExternalTurnRequest } from '@mangostudio/shared/generation';
import { useCallback, useRef, useState } from 'react';

/** Shared so a chat with no vendor choice keeps the same identity every render. */
const NO_EXTERNAL_TURN_REQUEST: ExternalTurnRequest = {};

export interface ExternalTurnRequestState {
  /** What the composer should show for the chat that is active now. */
  readonly externalTurnRequest: ExternalTurnRequest;
  readonly setExternalTurnRequest: (
    updater: (current: ExternalTurnRequest) => ExternalTurnRequest
  ) => void;
  /**
   * What the send path should put on the wire, or `undefined` for "the vendor
   * decides". Reads through a ref so it sees what is on screen now rather than
   * what was on screen when the callback was created.
   */
  readonly getExternalTurnRequest: () => ExternalTurnRequest | undefined;
}

export function useExternalTurnRequest(currentChatId: string | null): ExternalTurnRequestState {
  const [scoped, setScoped] = useState<{
    readonly chatId: string | null;
    readonly request: ExternalTurnRequest;
  }>({ chatId: currentChatId, request: NO_EXTERNAL_TURN_REQUEST });

  const externalTurnRequest =
    scoped.chatId === currentChatId ? scoped.request : NO_EXTERNAL_TURN_REQUEST;

  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;

  const setExternalTurnRequest = useCallback(
    (updater: (current: ExternalTurnRequest) => ExternalTurnRequest) => {
      setScoped((current) => {
        const chatId = currentChatIdRef.current;
        return {
          chatId,
          request: updater(current.chatId === chatId ? current.request : NO_EXTERNAL_TURN_REQUEST),
        };
      });
    },
    []
  );

  const requestRef = useRef(externalTurnRequest);
  requestRef.current = externalTurnRequest;
  const getExternalTurnRequest = useCallback(() => {
    const request = requestRef.current;
    return request.model === undefined && request.effort === undefined ? undefined : request;
  }, []);

  return { externalTurnRequest, setExternalTurnRequest, getExternalTurnRequest };
}
