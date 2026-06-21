import type { AgentProfile } from '@mangostudio/shared/agents';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import {
  assembleSubagentResult,
  createFailedResult,
  enforceSubagentRunResult,
  logSubagentError,
  logSubagentEvent,
  prepareSubagentTurn,
  recoverSubagentSummary,
  runPlainSubagentText,
  runSubagentStreamLoop,
} from './subagent-turn-stages';
import {
  type DelegateToSubagentRequest,
  SUBAGENT_ABORT_CODE,
  SUBAGENT_EMPTY_TEXT_FALLBACK,
  SUBAGENT_FAILED_CODE,
  SUBAGENT_TIMEOUT_CODE,
  SubagentDelegationError,
  type SubagentProgressEvent,
  type SubagentRunResult,
  type SubagentRuntimeInput,
  type SubagentStatus,
} from './subagent-turn-types';

export {
  type DelegateToSubagentRequest,
  SUBAGENT_EMPTY_TEXT_FALLBACK,
  SubagentDelegationError,
  type SubagentProgressEvent,
  type SubagentRunResult,
  type SubagentRuntimeInput,
  type SubagentStatus,
};

export async function runSubagentTurn(input: SubagentRuntimeInput): Promise<SubagentRunResult> {
  assertDelegationAllowed(input);

  const startedAt = Date.now();
  const targetProfile = await getAgentProfile(input.db, input.userId, input.request.agentId);
  assertTargetAllowed(input.parentAgentProfile, targetProfile);
  logSubagentEvent('start', {
    chatId: input.chatId,
    userId: input.userId,
    parentAgentId: input.parentAgentProfile.id,
    targetAgentId: targetProfile.id,
    depth: input.depth,
  });
  input.onEvent?.({
    type: 'started',
    agentId: targetProfile.id,
    agentName: targetProfile.name,
    task: input.request.task,
  });

  const childAbort = createLinkedAbortController(input.signal);
  const timeout = setTimeout(
    () => childAbort.controller.abort(SUBAGENT_TIMEOUT_CODE),
    input.settings.timeoutMs
  );

  try {
    const result = await runWithTimeout(
      executeSubagentTurn({ ...input, targetProfile, signal: childAbort.controller.signal }),
      childAbort.controller.signal,
      input.settings.timeoutMs
    );
    if (!result.summary.trim()) {
      logSubagentEvent('empty_response_synthesized', {
        chatId: input.chatId,
        userId: input.userId,
        parentAgentId: input.parentAgentProfile.id,
        targetAgentId: result.agentId,
        toolCallCount: result.tools.length,
      });
    }
    const enforced = enforceSubagentRunResult(result);
    // If the original result had no summary, we synthesized a fallback, so emit it as text.
    if (!result.summary.trim()) {
      input.onEvent?.({ type: 'text', agentId: enforced.agentId, text: enforced.summary });
    }
    input.onEvent?.({
      type: 'completed',
      agentId: enforced.agentId,
      agentName: enforced.agentName,
      summary: enforced.summary,
      toolCallCount: enforced.toolCallCount,
    });
    logSubagentEvent('completed', {
      chatId: input.chatId,
      userId: input.userId,
      parentAgentId: input.parentAgentProfile.id,
      targetAgentId: enforced.agentId,
      status: enforced.status,
      toolCallCount: enforced.toolCallCount,
      summaryLength: enforced.summary.length,
      durationMs: enforced.durationMs,
    });
    return enforced;
  } catch (error) {
    const normalized = normalizeSubagentFailure(error, childAbort.controller.signal);
    input.onEvent?.({
      type: 'failed',
      agentId: targetProfile.id,
      agentName: targetProfile.name,
      error: normalized.message,
    });
    const failed = createFailedResult({
      profile: targetProfile,
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
      durationMs: Date.now() - startedAt,
    });
    logSubagentError('failed', {
      chatId: input.chatId,
      userId: input.userId,
      parentAgentId: input.parentAgentProfile.id,
      targetAgentId: targetProfile.id,
      status: failed.status,
      code: failed.error?.code ?? SUBAGENT_FAILED_CODE,
      message: failed.summary,
      durationMs: failed.durationMs,
    });
    return failed;
  } finally {
    clearTimeout(timeout);
    childAbort.dispose();
  }
}

function assertDelegationAllowed(input: SubagentRuntimeInput): void {
  if (!input.settings.enabled) {
    throw new SubagentDelegationError('Multi-agent delegation is disabled.', 'DISABLED');
  }
  if (input.parentMode === 'chat' && !input.settings.chatDelegationEnabled) {
    throw new SubagentDelegationError('Chat mode delegation is disabled.', 'CHAT_DISABLED');
  }
  if (input.depth >= input.settings.maxDepth) {
    throw new SubagentDelegationError('Maximum delegation depth reached.', 'MAX_DEPTH');
  }
}

function assertTargetAllowed(parent: AgentProfile, target: AgentProfile): void {
  if (!parent.subagentIds.includes(target.id)) {
    throw new SubagentDelegationError(
      `Agent "${target.id}" is not in the parent agent subagent allowlist.`,
      'TARGET_NOT_ALLOWED'
    );
  }
  if (target.role !== 'subagent' && target.role !== 'both') {
    throw new SubagentDelegationError(
      `Agent "${target.id}" cannot be used as a subagent.`,
      'INVALID_ROLE'
    );
  }
}

/**
 * Execute one subagent turn by orchestrating the stage functions: prepare,
 * stream (or plain text), recover, and assemble.
 */
async function executeSubagentTurn(
  input: SubagentRuntimeInput & {
    readonly targetProfile: AgentProfile;
    readonly signal: AbortSignal;
  }
): Promise<SubagentRunResult> {
  const startedAt = Date.now();
  const session = await prepareSubagentTurn(input);

  if (!session.provider.generateAgentTurnStream) {
    const text = await runPlainSubagentText(session);
    session.summary = text;
    const result = assembleSubagentResult(session, Date.now() - startedAt);
    input.onEvent?.({ type: 'text', agentId: session.runtime.profile.id, text: result.summary });
    return result;
  }

  const { providerState } = await runSubagentStreamLoop(session);

  if (!session.summary.trim() && session.tools.length > 0) {
    const recovered = await recoverSubagentSummary(session, providerState);
    if (recovered.trim()) {
      session.summary += recovered;
    }
  }

  return assembleSubagentResult(session, Date.now() - startedAt);
}

interface LinkedAbortController {
  readonly controller: AbortController;
  readonly dispose: () => void;
}

const noop = (): void => undefined;

function createLinkedAbortController(parent?: AbortSignal): LinkedAbortController {
  const controller = new AbortController();
  if (!parent) return { controller, dispose: noop };
  if (parent.aborted) {
    controller.abort(SUBAGENT_ABORT_CODE);
    return { controller, dispose: noop };
  }
  const onParentAbort = () => controller.abort(SUBAGENT_ABORT_CODE);
  parent.addEventListener('abort', onParentAbort, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener('abort', onParentAbort),
  };
}

function runWithTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new SubagentDelegationError(`Subagent timed out after ${timeoutMs}ms.`, 'TIMEOUT'));
    }, timeoutMs);
  });

  if (signal.aborted) {
    return Promise.reject(new SubagentDelegationError('Subagent aborted.', 'ABORTED'));
  }

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function normalizeSubagentFailure(
  error: unknown,
  signal: AbortSignal
): { status: Exclude<SubagentStatus, 'completed'>; code: string; message: string } {
  if (signal.aborted && signal.reason === SUBAGENT_TIMEOUT_CODE) {
    return { status: 'timeout', code: SUBAGENT_TIMEOUT_CODE, message: 'Subagent timed out.' };
  }
  if (signal.aborted) {
    return { status: 'aborted', code: SUBAGENT_ABORT_CODE, message: 'Subagent aborted.' };
  }
  if (error instanceof SubagentDelegationError && error.code === 'TIMEOUT') {
    return { status: 'timeout', code: SUBAGENT_TIMEOUT_CODE, message: error.message };
  }
  if (error instanceof Error) {
    return { status: 'failed', code: SUBAGENT_FAILED_CODE, message: error.message };
  }
  return { status: 'failed', code: SUBAGENT_FAILED_CODE, message: 'Subagent failed.' };
}
