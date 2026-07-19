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
  McpElicitationTerminalReason,
  McpElicitationTerminalStatus,
  RespondMcpElicitationBody,
} from '@mangostudio/shared/mcp';
import { createDiagnosticLogger } from '../../lib/logger';

type McpElicitationResultAction = 'accept' | 'decline' | 'cancel';

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

/** First (and only) terminal transition of a pending elicitation. */
export interface McpElicitationStatusEvent {
  elicitationId: string;
  toolCallId: string;
  status: McpElicitationTerminalStatus;
  reason: McpElicitationTerminalReason;
}

export type McpElicitationStatusObserver = (event: McpElicitationStatusEvent) => void;

/** Server-side causes for cancelling a still-pending elicitation. */
export type McpElicitationCancelReason = Extract<
  McpElicitationTerminalReason,
  'tool_timeout' | 'tool_finished' | 'tool_failed' | 'server_closed'
>;

interface PendingElicitation {
  userId: string;
  serverId: string;
  serverSlug: string;
  toolCallId: string;
  part: McpElicitationPart;
  settle: (
    status: McpElicitationTerminalStatus,
    reason: McpElicitationTerminalReason,
    result: McpElicitationResult
  ) => void;
  cleanup: () => void;
}

interface BoundSink {
  sink: McpElicitationSink;
  onStatus?: McpElicitationStatusObserver;
}

const pending = new Map<string, PendingElicitation>();
const sinks = new Map<string, BoundSink>();
const logger = createDiagnosticLogger('mcp-elicitation');

function sinkKey(userId: string, serverId: string, toolCallId: string): string {
  return JSON.stringify([userId, serverId, toolCallId]);
}

/**
 * Binds a turn-scoped sink for mid-call elicitation events. The optional
 * status observer is captured per pending entry at creation time, so terminal
 * transitions still notify after the sink itself is released.
 */
export function bindElicitationSink(
  userId: string,
  serverId: string,
  toolCallId: string,
  sink: McpElicitationSink,
  onStatus?: McpElicitationStatusObserver
): void {
  sinks.set(sinkKey(userId, serverId, toolCallId), { sink, onStatus });
}

/** Removes the turn-scoped sink; does not cancel already-pending entries. */
export function releaseElicitationSink(userId: string, serverId: string, toolCallId: string): void {
  sinks.delete(sinkKey(userId, serverId, toolCallId));
}

/**
 * Parks a form elicitation and notifies the active sink. Without a sink, or
 * when the parent signal is already aborted, resolves as `cancel`.
 */
export function createPendingElicitation(
  input: McpElicitationRequestInput
): Promise<McpElicitationResult> {
  const bound = sinks.get(sinkKey(input.userId, input.serverId, input.toolCallId));
  if (!bound || input.signal?.aborted) {
    logger.warn(
      input.signal?.aborted ? 'elicitation_parent_aborted' : 'elicitation_sink_unavailable',
      {
        serverSlug: input.serverSlug,
        toolCallId: input.toolCallId,
      }
    );
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

  const onStatus = bound.onStatus;
  let settled = false;
  const waitForResponse = new Promise<McpElicitationResult>((resolve) => {
    const settle: PendingElicitation['settle'] = (status, reason, result) => {
      if (settled) return;
      settled = true;
      pending.delete(elicitationId);
      input.signal?.removeEventListener('abort', onAbort);
      // Mutate in place so the MessagePart already pushed into the turn's
      // `allParts` (same object reference) reflects the terminal state on
      // persist; notify only after the part carries both status and reason.
      part.status = status;
      part.reason = reason;
      onStatus?.({ elicitationId, toolCallId: input.toolCallId, status, reason });
      resolve(result);
    };

    const onAbort = () => settle('cancelled', 'turn_aborted', { action: 'cancel' });
    if (input.signal) {
      input.signal.addEventListener('abort', onAbort, { once: true });
    }

    pending.set(elicitationId, {
      userId: input.userId,
      serverId: input.serverId,
      serverSlug: input.serverSlug,
      toolCallId: input.toolCallId,
      part,
      settle,
      cleanup: () => input.signal?.removeEventListener('abort', onAbort),
    });
  });

  bound.sink(part, waitForResponse);
  return waitForResponse;
}

/**
 * Resolves a pending elicitation for the owning user. Returns the new status,
 * or `null` when the id is unknown, already terminal, or owned by someone
 * else — a late response can never move a settled state.
 */
export function respondElicitation(
  userId: string,
  elicitationId: string,
  body: RespondMcpElicitationBody
): McpElicitationStatus | null {
  const entry = pending.get(elicitationId);
  if (!entry || entry.userId !== userId) return null;

  const status = actionToStatus(body.action);
  entry.settle(status, 'responded', {
    action: body.action,
    ...(body.action === 'accept' && body.content ? { content: body.content } : {}),
  });
  return status;
}

/**
 * Cancels the given still-pending elicitations (leftovers after a tool call
 * ends cleanly, reports `isError`, throws, times out, aborts, or loses its
 * session). Scoped by id — not by server — so a finishing tool call never
 * cancels a concurrent same-server call's pending elicitation.
 */
export function cancelPendingElicitations(
  elicitationIds: readonly string[],
  reason: McpElicitationCancelReason = 'tool_finished'
): void {
  for (const id of elicitationIds) {
    pending.get(id)?.settle('cancelled', reason, { action: 'cancel' });
  }
}

/** Test helper: drop all pending elicitations and sinks. */
export function resetElicitationRegistryForTest(): void {
  for (const entry of [...pending.values()]) {
    entry.cleanup();
    entry.settle('cancelled', 'server_closed', { action: 'cancel' });
  }
  pending.clear();
  sinks.clear();
}

function actionToStatus(action: RespondMcpElicitationBody['action']): McpElicitationTerminalStatus {
  switch (action) {
    case 'accept':
      return 'accepted';
    case 'decline':
      return 'declined';
    case 'cancel':
      return 'cancelled';
  }
}
