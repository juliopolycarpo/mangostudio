import type { AgentId, SubagentTraceEvent } from '@mangostudio/shared';
import {
  DELEGATION_BACKOFF_BASE_MS,
  DELEGATION_BACKOFF_MAX_MS,
  DELEGATION_MAX_RETRIES,
  mergeSubagentTraceEvents,
} from '@mangostudio/shared';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getSubagentCachedEntry } from './subagent-response-cache';
import {
  type DelegateToSubagentRequest,
  SUBAGENT_EMPTY_TEXT_FALLBACK,
  SubagentDelegationError,
  type SubagentRunResult,
} from './subagent-runner';

const delegationLogger = createDiagnosticLogger('subagent-delegation');

export interface DelegationRetryContext {
  signal?: AbortSignal;
  timeoutMs: number;
  onEvent?: (event: { type: 'system_event'; event: string; detail: string }) => void;
  executeDelegation: (
    callId: string,
    request: DelegateToSubagentRequest
  ) => Promise<SubagentRunResult>;
}

export async function ensureDelegationResult(
  callId: string,
  request: DelegateToSubagentRequest,
  context: DelegationRetryContext
): Promise<SubagentRunResult> {
  const maxAttempts = 1 + DELEGATION_MAX_RETRIES;
  const events: SubagentTraceEvent[] = [];
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptRequest =
      attempt === 1 ? request : addEnforcedDelegationOutputRequirement(request);

    try {
      if (attempt > 1) {
        await sleepWithAbort(
          computeBackoffMs(attempt),
          context.signal,
          `call=${callId} attempt=${attempt}`
        );
      }
      events.push({
        event: 'response_attempt',
        attempt,
        detail: `call=${callId} attempt=${attempt}`,
      });
      context.onEvent?.({
        type: 'system_event',
        event: 'subagent_response_attempt',
        detail: `call=${callId} attempt=${attempt}`,
      });

      const result = (await withDelegationTimeout(
        context.executeDelegation(callId, attemptRequest),
        context.timeoutMs,
        context.signal
      )) as unknown;
      if (isValidSubagentResult(result)) {
        return withSubagentTraceEvents(result, events);
      }

      const cacheEntry = getSubagentCachedEntry(callId);
      const recovered = tryRecoverFromCache(callId, request.agentId, cacheEntry);
      if (recovered) {
        logDelegationWarn('recovered_from_cache', {
          callId,
          agentId: request.agentId,
          attempt,
          summaryLength: recovered.summary.length,
          cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
        });
        context.onEvent?.({
          type: 'system_event',
          event: 'subagent_response_recovered',
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        events.push({
          event: 'response_recovered',
          attempt,
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        return withSubagentTraceEvents(recovered, events);
      }

      lastError = 'Subagent returned an invalid or empty response.';
      logDelegationWarn('invalid_result', {
        callId,
        agentId: request.agentId,
        attempt,
        status: isSubagentRunResult(result) ? result.status : 'invalid',
        summaryLength: isSubagentRunResult(result) ? result.summary.length : 0,
        toolCallCount: isSubagentRunResult(result) ? result.toolCallCount : 0,
        scenario: classifyMissingResponseScenario(cacheEntry),
        cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
      });
    } catch (error) {
      if (error instanceof SubagentDelegationError && error.code === 'TIMEOUT') {
        const text = `Subagent timed out after ${context.timeoutMs}ms.`;
        logDelegationWarn('timeout', {
          callId,
          agentId: request.agentId,
          attempt,
          error: text,
        });
        context.onEvent?.({
          type: 'system_event',
          event: 'subagent_response_timeout',
          detail: `call=${callId} agent=${request.agentId}`,
        });
        events.push({
          event: 'response_timeout',
          attempt,
          detail: `call=${callId} agent=${request.agentId}`,
        });
        return withSubagentTraceEvents(
          createTimedOutSubagentResult(callId, request.agentId, text),
          events
        );
      }
      if (isNonRetryableDelegationError(error)) {
        throw error;
      }
      lastError = errorToToolMessage(error);
      const cacheEntry = getSubagentCachedEntry(callId);
      const recovered = tryRecoverFromCache(callId, request.agentId, cacheEntry);
      if (recovered) {
        logDelegationWarn('recovered_from_cache_after_error', {
          callId,
          agentId: request.agentId,
          attempt,
          summaryLength: recovered.summary.length,
          cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
        });
        context.onEvent?.({
          type: 'system_event',
          event: 'subagent_response_recovered',
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        events.push({
          event: 'response_recovered',
          attempt,
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        return withSubagentTraceEvents(recovered, events);
      }
      logDelegationWarn('attempt_failed', {
        callId,
        agentId: request.agentId,
        attempt,
        error: lastError,
        scenario: classifyMissingResponseScenario(cacheEntry),
        cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
      });
    }
  }

  const cacheEntry = getSubagentCachedEntry(callId);
  const recovered = tryRecoverFromCache(callId, request.agentId, cacheEntry);
  if (recovered) return withSubagentTraceEvents(recovered, events);

  const summary = `Subagent failed to produce a final response. ${lastError}`.trim();
  const fallback = createMissingSubagentResult(callId, request.agentId, summary);
  context.onEvent?.({
    type: 'system_event',
    event: 'subagent_response_fallback',
    detail: `call=${callId} agent=${request.agentId}`,
  });
  events.push({
    event: 'response_fallback',
    detail: `call=${callId} agent=${request.agentId}`,
  });
  return withSubagentTraceEvents(fallback, events);
}

function withSubagentTraceEvents(
  result: SubagentRunResult,
  events: ReadonlyArray<SubagentTraceEvent>
): SubagentRunResult {
  if (events.length === 0) return result;
  const mergedEvents = mergeSubagentTraceEvents(result.trace.events, events);
  return {
    ...result,
    trace: {
      ...result.trace,
      events: mergedEvents,
    },
  };
}

function isNonRetryableDelegationError(error: unknown): boolean {
  const code = getDelegationErrorCode(error);
  if (!code) return false;
  return [
    'ABORTED',
    'DISABLED',
    'CHAT_DISABLED',
    'MAX_CALLS',
    'MAX_DEPTH',
    'TARGET_NOT_ALLOWED',
    'INVALID_ROLE',
    'INVALID_AGENT_ID',
  ].includes(code);
}

function getDelegationErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { code?: unknown; name?: unknown };
  if (typeof record.code !== 'string') return undefined;
  if (record.name !== 'SubagentDelegationError') return undefined;
  return record.code;
}

function tryRecoverFromCache(
  callId: string,
  agentId: AgentId,
  cacheEntry: ReturnType<typeof getSubagentCachedEntry>
): SubagentRunResult | undefined {
  const cachedResult = cacheEntry?.result;
  if (cachedResult && isValidSubagentResult(cachedResult)) return cachedResult;
  const partial = cacheEntry?.partialText?.trim() ?? '';
  if (!partial || partial.startsWith(SUBAGENT_EMPTY_TEXT_FALLBACK)) return undefined;
  return createRecoveredSubagentResult(callId, agentId, partial);
}

function createRecoveredSubagentResult(
  callId: string,
  agentId: AgentId,
  summary: string
): SubagentRunResult {
  const text = summary.trim() || 'Subagent response recovered from cache.';
  return {
    agentId,
    agentName: agentId,
    status: 'completed',
    summary: text,
    messages: [{ role: 'assistant', text }],
    toolCallCount: 0,
    tools: [],
    durationMs: 0,
    trace: {
      type: 'subagent_trace',
      toolCallId: callId,
      agentId,
      agentName: agentId,
      status: 'completed',
      summary: text,
      toolCallCount: 0,
      lastMessage: text,
      messages: [{ role: 'assistant', text }],
      tools: [],
    },
  };
}

function createTimedOutSubagentResult(
  callId: string,
  agentId: AgentId,
  summary: string
): SubagentRunResult {
  const text = summary.trim() || 'Subagent timed out.';
  return {
    agentId,
    agentName: agentId,
    status: 'timeout',
    summary: text,
    messages: [{ role: 'assistant', text }],
    toolCallCount: 0,
    tools: [],
    durationMs: 0,
    error: { code: 'TIMEOUT', message: text },
    trace: {
      type: 'subagent_trace',
      toolCallId: callId,
      agentId,
      agentName: agentId,
      status: 'timeout',
      summary: text,
      toolCallCount: 0,
      lastMessage: text,
      messages: [{ role: 'assistant', text }],
      tools: [],
      error: text,
    },
  };
}

function classifyMissingResponseScenario(
  cacheEntry: ReturnType<typeof getSubagentCachedEntry>
): 'produced_not_transmitted' | 'not_produced' {
  const partial = cacheEntry?.partialText?.trim() ?? '';
  if (partial) return 'produced_not_transmitted';
  return 'not_produced';
}

function computeBackoffMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 2);
  const base = Math.min(DELEGATION_BACKOFF_MAX_MS, DELEGATION_BACKOFF_BASE_MS * 2 ** exponent);
  const jitter = 0.2 * base;
  const randomized = base + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(Math.min(DELEGATION_BACKOFF_MAX_MS, randomized)));
}

async function sleepWithAbort(ms: number, signal?: AbortSignal, label?: string): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error('Aborted');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      clearTimeout(timeoutId);
      reject(new Error('Aborted'));
    };
    if (label) {
      logDelegationWarn('backoff', { ms, label });
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withDelegationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  // Check abort before arming the timer: returning early after the setTimeout
  // is scheduled leaks the timer and leaves timeoutPromise to reject unhandled
  // once it fires.
  if (signal?.aborted) {
    return Promise.reject(new SubagentDelegationError('Subagent aborted.', 'ABORTED'));
  }
  const effective = Math.max(1_000, Math.round(timeoutMs));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(new SubagentDelegationError(`Subagent timed out after ${effective}ms.`, 'TIMEOUT')),
      effective
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

/**
 * A subagent result is "valid" for the parent agent when it has a usable summary.
 *
 * The synthesized tool-summary fallback (which starts with SUBAGENT_EMPTY_TEXT_FALLBACK)
 * is intentionally accepted here: the subagent-runner now performs an explicit
 * summarize follow-up turn before falling back, so by the time we reach this
 * point with the fallback prefix the underlying model already declined to
 * summarize. Retrying the entire delegation from scratch in that case is
 * non-deterministic and wastes tokens — the fallback (with the list of tools
 * actually executed) is the most useful response available.
 *
 * Only truly malformed results (wrong shape, empty summary, or no assistant
 * message) trigger the retry path, which is reserved for genuine runner
 * failures (exceptions, malformed mocks, etc).
 */
function isValidSubagentResult(result: unknown): result is SubagentRunResult {
  if (!isSubagentRunResult(result)) return false;
  if (!result.summary.trim()) return false;
  const last = result.trace.lastMessage?.trim() ?? '';
  if (!last) return false;
  const messagesValue = (result.trace as unknown as { messages?: unknown }).messages;
  if (!Array.isArray(messagesValue)) return false;
  for (const message of messagesValue) {
    if (isSubagentTraceMessage(message) && message.role === 'assistant' && message.text.trim()) {
      return true;
    }
  }
  return false;
}

export function isSubagentRunResult(value: unknown): value is SubagentRunResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<SubagentRunResult>;
  return (
    typeof result.agentId === 'string' &&
    typeof result.agentName === 'string' &&
    typeof result.summary === 'string' &&
    Boolean(result.trace) &&
    typeof result.trace === 'object'
  );
}

function addEnforcedDelegationOutputRequirement(
  request: DelegateToSubagentRequest
): DelegateToSubagentRequest {
  const suffix =
    'Always end with a non-empty, plain-text summary. If you used tools, summarize the outcomes.';
  const expectedOutput = request.expectedOutput?.trim();
  if (!expectedOutput) return { ...request, expectedOutput: suffix };
  if (expectedOutput.includes(suffix)) return request;
  return { ...request, expectedOutput: `${expectedOutput}\n\n${suffix}` };
}

function createMissingSubagentResult(
  callId: string,
  agentId: AgentId,
  summary: string
): SubagentRunResult {
  const text = summary.trim() || 'Subagent response missing.';
  return {
    agentId,
    agentName: agentId,
    status: 'failed',
    summary: text,
    messages: [{ role: 'assistant', text }],
    toolCallCount: 0,
    tools: [],
    durationMs: 0,
    error: { code: 'FAILED', message: text },
    trace: {
      type: 'subagent_trace',
      toolCallId: callId,
      agentId,
      agentName: agentId,
      status: 'failed',
      summary: text,
      toolCallCount: 0,
      lastMessage: text,
      messages: [{ role: 'assistant', text }],
      tools: [],
      error: text,
    },
  };
}

function isSubagentTraceMessage(
  value: unknown
): value is { role: 'assistant' | 'system'; text: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.role === 'assistant' || record.role === 'system') && typeof record.text === 'string'
  );
}

function errorToToolMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Tool execution failed';
}

type LogValue = string | number | boolean;
type LogMetadata = Record<string, LogValue>;

export function logDelegationWarn(event: string, metadata: LogMetadata): void {
  delegationLogger.warn(event, metadata);
}
