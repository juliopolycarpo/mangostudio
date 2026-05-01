/**
 * Structured continuation observability.
 *
 * Replaces scattered console.warn calls with typed, machine-parseable log
 * entries for operator debugging, monitoring, and audit trails.
 *
 * All functions return void — they only log. No side effects beyond the log call.
 */

import type { ContinuationReasonCode, ProviderType } from '@mangostudio/shared/types';

type LogMetadata = Record<string, string | number | boolean>;

function logEvent(event: string, metadata: LogMetadata): void {
  const ts = Date.now();
  console.warn(`[continuation] ${JSON.stringify({ event, ts, ...metadata })}`);
}

function logError(event: string, metadata: LogMetadata): void {
  const ts = Date.now();
  console.error(`[continuation] ${JSON.stringify({ event, ts, ...metadata })}`);
}

export interface DegradeParams {
  chatId: string;
  provider: ProviderType;
  model: string;
  from: string;
  to: string;
  reason: string;
  reasonCode: ContinuationReasonCode;
  fromProvider?: ProviderType;
}

export function logDegrade(params: DegradeParams): void {
  logEvent('degrade', {
    chatId: params.chatId,
    provider: params.provider,
    model: params.model,
    from: params.from,
    to: params.to,
    reason: params.reason,
    reasonCode: params.reasonCode,
    ...(params.fromProvider ? { fromProvider: params.fromProvider } : {}),
  });
}

export interface ValidContinuationParams {
  chatId: string;
  provider: ProviderType;
  model: string;
  mode: string;
}

export function logValidContinuation(params: ValidContinuationParams): void {
  logEvent('valid_continue', {
    chatId: params.chatId,
    provider: params.provider,
    model: params.model,
    mode: params.mode,
  });
}

export interface StateUpdateParams {
  chatId: string;
  provider: ProviderType;
  mode: string;
  hasCursor: boolean;
}

export function logStateUpdate(params: StateUpdateParams): void {
  logEvent('updated', {
    chatId: params.chatId,
    provider: params.provider,
    mode: params.mode,
    hasCursor: params.hasCursor,
  });
}

export interface PersistenceErrorParams {
  chatId: string;
  error: string;
  phase: string;
}

export function logPersistenceError(params: PersistenceErrorParams): void {
  logError('persist_error', {
    chatId: params.chatId,
    error: params.error,
    phase: params.phase,
  });
}

export interface StateClearedParams {
  chatId: string;
  reason: string;
  error?: string;
}

export function logStateCleared(params: StateClearedParams): void {
  logEvent('state_cleared', {
    chatId: params.chatId,
    reason: params.reason,
    ...(params.error ? { error: params.error } : {}),
  });
}

export interface ContextInfoParams {
  chatId: string;
  provider: ProviderType;
  model: string;
  inputTokens: number;
  limit: number;
  ratio: number;
  mode: string;
}

export function logContextInfo(params: ContextInfoParams): void {
  logEvent('context', {
    chatId: params.chatId,
    provider: params.provider,
    model: params.model,
    inputTokens: params.inputTokens,
    limit: params.limit,
    ratio: params.ratio,
    mode: params.mode,
  });
}

export interface ProviderDegradeParams {
  chatId?: string;
  provider: string;
  model?: string;
  reason: string;
  reasonCode: ContinuationReasonCode;
  status?: number | string;
  toolResults?: boolean;
}

export function logProviderDegrade(params: ProviderDegradeParams): void {
  logEvent('provider_degrade', {
    ...(params.chatId ? { chatId: params.chatId } : {}),
    provider: params.provider,
    ...(params.model ? { model: params.model } : {}),
    reason: params.reason,
    reasonCode: params.reasonCode,
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.toolResults !== undefined ? { toolResults: params.toolResults } : {}),
  });
}

export function logAbortToolLoop(params: { chatId?: string; provider: string }): void {
  logEvent('abort_tool_loop', {
    ...(params.chatId ? { chatId: params.chatId } : {}),
    provider: params.provider,
  });
}
