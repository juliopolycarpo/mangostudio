import type { MessagePart } from '@mangostudio/shared/types';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

/** Where a retry from a tool card is sent, and which calls of the message already have one. */
interface ToolCallRetryScope {
  readonly chatId: string;
  readonly messageId: string;
  /** `toolCallId`s some later call of the message re-ran: the hub allows one retry per call. */
  readonly retriedCallIds: ReadonlySet<string>;
}

const ToolCallRetryContext = createContext<ToolCallRetryScope | null>(null);

interface ToolCallRetryProviderProps extends ToolCallRetryScope {
  readonly children: ReactNode;
}

/**
 * Scopes the tool cards under it to one assistant message, so a card can ask the
 * hub to run its call again. Cards outside a provider (a preview, a message with
 * no chat) offer no Retry.
 *
 * // Usage: <ToolCallRetryProvider chatId={id} messageId={mid} retriedCallIds={ids}>…</ToolCallRetryProvider>
 */
export function ToolCallRetryProvider({
  chatId,
  messageId,
  retriedCallIds,
  children,
}: ToolCallRetryProviderProps) {
  const value = useMemo(
    () => ({ chatId, messageId, retriedCallIds }),
    [chatId, messageId, retriedCallIds]
  );
  return <ToolCallRetryContext.Provider value={value}>{children}</ToolCallRetryContext.Provider>;
}

export function useToolCallRetryScope(): ToolCallRetryScope | null {
  return useContext(ToolCallRetryContext);
}

/** The calls of a message that a later call re-ran. */
export function collectRetriedCallIds(parts: readonly MessagePart[]): ReadonlySet<string> {
  const retried = new Set<string>();
  for (const part of parts) {
    if (part.type === 'tool_call' && part.retryOf !== undefined) retried.add(part.retryOf);
  }
  return retried;
}
