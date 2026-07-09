/**
 * In-memory pending MCP form elicitations. Mid-tool-call `elicitation/create`
 * requests park here until the chat UI posts a response (or timeout/abort
 * cancels). Turn-scoped sinks decide which in-flight tool call receives a
 * request; without a sink the handler returns `{ action: 'cancel' }`.
 */

import type {
  McpElicitationField,
  McpElicitationPart,
  McpElicitationStatus,
  RespondMcpElicitationBody,
} from '@mangostudio/shared/mcp';

export type McpElicitationResultAction = 'accept' | 'decline' | 'cancel';

export interface McpElicitationResult {
  action: McpElicitationResultAction;
  content?: Record<string, string | number | boolean | string[]>;
}

export interface McpElicitationRequestInput {
  userId: string;
  serverId: string;
  serverSlug: string;
  toolCallId: string;
  message: string;
  fields: McpElicitationField[];
  signal?: AbortSignal;
}

export type McpElicitationSink = (
  part: McpElicitationPart,
  waitForResponse: Promise<McpElicitationResult>
) => void;

interface PendingElicitation {
  userId: string;
  serverId: string;
  serverSlug: string;
  toolCallId: string;
  part: McpElicitationPart;
  resolve: (result: McpElicitationResult) => void;
  cleanup: () => void;
}

const pending = new Map<string, PendingElicitation>();
const sinks = new Map<string, McpElicitationSink>();

function sinkKey(userId: string, serverId: string): string {
  return `${userId}:${serverId}`;
}

/** Binds a turn-scoped sink for mid-call elicitation events. */
export function bindElicitationSink(
  userId: string,
  serverId: string,
  sink: McpElicitationSink
): void {
  sinks.set(sinkKey(userId, serverId), sink);
}

/** Removes the turn-scoped sink; does not cancel already-pending entries. */
export function releaseElicitationSink(userId: string, serverId: string): void {
  sinks.delete(sinkKey(userId, serverId));
}

/**
 * Parks a form elicitation and notifies the active sink. Without a sink, or
 * when the parent signal is already aborted, resolves as `cancel`.
 */
export function createPendingElicitation(
  input: McpElicitationRequestInput
): Promise<McpElicitationResult> {
  const sink = sinks.get(sinkKey(input.userId, input.serverId));
  if (!sink || input.signal?.aborted) {
    return Promise.resolve({ action: 'cancel' });
  }

  const elicitationId = crypto.randomUUID();
  const part: McpElicitationPart = {
    type: 'mcp_elicitation',
    elicitationId,
    toolCallId: input.toolCallId,
    serverSlug: input.serverSlug,
    message: input.message,
    fields: input.fields,
    status: 'pending',
  };

  let settled = false;
  const waitForResponse = new Promise<McpElicitationResult>((resolve) => {
    const finish = (result: McpElicitationResult) => {
      if (settled) return;
      settled = true;
      pending.delete(elicitationId);
      input.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => finish({ action: 'cancel' });
    if (input.signal) {
      input.signal.addEventListener('abort', onAbort, { once: true });
    }

    pending.set(elicitationId, {
      userId: input.userId,
      serverId: input.serverId,
      serverSlug: input.serverSlug,
      toolCallId: input.toolCallId,
      part,
      resolve: finish,
      cleanup: () => input.signal?.removeEventListener('abort', onAbort),
    });
  });

  sink(part, waitForResponse);
  return waitForResponse;
}

/**
 * Resolves a pending elicitation for the owning user. Returns the new status,
 * or `null` when the id is unknown / owned by someone else.
 */
export function respondElicitation(
  userId: string,
  elicitationId: string,
  body: RespondMcpElicitationBody
): McpElicitationStatus | null {
  const entry = pending.get(elicitationId);
  if (!entry || entry.userId !== userId) return null;

  const status = actionToStatus(body.action);
  // Mutate in place so the MessagePart already pushed into the turn's
  // `allParts` (same object reference) reflects the final status on persist.
  entry.part.status = status;
  entry.resolve({
    action: body.action,
    ...(body.action === 'accept' && body.content ? { content: body.content } : {}),
  });
  return status;
}

/**
 * Cancels the given still-pending elicitations (leftovers after a tool call
 * ends or times out). Scoped by id — not by server — so a finishing tool call
 * never cancels a concurrent same-server call's pending elicitation.
 */
export function cancelPendingElicitations(elicitationIds: readonly string[]): void {
  for (const id of elicitationIds) {
    const entry = pending.get(id);
    if (!entry) continue;
    entry.part.status = 'cancelled';
    entry.resolve({ action: 'cancel' });
  }
}

/** Test helper: drop all pending elicitations and sinks. */
export function resetElicitationRegistryForTest(): void {
  for (const entry of pending.values()) {
    entry.cleanup();
    entry.resolve({ action: 'cancel' });
  }
  pending.clear();
  sinks.clear();
}

function actionToStatus(action: RespondMcpElicitationBody['action']): McpElicitationStatus {
  switch (action) {
    case 'accept':
      return 'accepted';
    case 'decline':
      return 'declined';
    case 'cancel':
      return 'cancelled';
  }
}
