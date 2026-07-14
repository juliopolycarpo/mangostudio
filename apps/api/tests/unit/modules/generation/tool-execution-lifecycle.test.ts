import { describe, expect, it } from 'bun:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { SubagentDelegationError } from '../../../../src/modules/generation/application/subagent-turn-types';
import {
  classifyToolExecutionFailure,
  classifyToolExecutionSource,
  subagentStatusToTerminal,
  ToolExecutionLifecycle,
  type ToolExecutionTransitionEvent,
  ToolPolicyError,
} from '../../../../src/modules/generation/application/tool-execution-lifecycle';
import { ToolArgumentError } from '../../../../src/services/tools/arg-parsing';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';

describe('classifyToolExecutionFailure', () => {
  it('maps timeouts from the shared wrapper and self-timing tools to timed_out', () => {
    expect(classifyToolExecutionFailure(new ToolExecutionTimedOutError('boom'))).toEqual({
      status: 'timed_out',
      reasonCode: 'timeout',
    });
  });

  it('maps MCP SDK timeout and connection-closed failures', () => {
    expect(
      classifyToolExecutionFailure(new McpError(ErrorCode.RequestTimeout, 'timed out'))
    ).toEqual({ status: 'timed_out', reasonCode: 'timeout' });
    expect(
      classifyToolExecutionFailure(new McpError(ErrorCode.ConnectionClosed, 'closed'))
    ).toEqual({ status: 'failed', reasonCode: 'server_closed' });
  });

  it('maps abort errors and an aborted parent signal to cancelled', () => {
    expect(classifyToolExecutionFailure(new DOMException('stop', 'AbortError'))).toEqual({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
    const controller = new AbortController();
    controller.abort();
    expect(classifyToolExecutionFailure(new Error('interrupted'), controller.signal)).toEqual({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
  });

  it('maps policy and validation errors to their reason codes', () => {
    expect(classifyToolExecutionFailure(new ToolPolicyError('not allowed', 'not_allowed'))).toEqual(
      { status: 'failed', reasonCode: 'not_allowed' }
    );
    expect(classifyToolExecutionFailure(new ToolPolicyError('off', 'tool_disabled'))).toEqual({
      status: 'failed',
      reasonCode: 'tool_disabled',
    });
    expect(classifyToolExecutionFailure(new ToolArgumentError('missing field'))).toEqual({
      status: 'failed',
      reasonCode: 'validation_failed',
    });
  });

  it('maps subagent delegation errors by code', () => {
    expect(classifyToolExecutionFailure(new SubagentDelegationError('t', 'TIMEOUT'))).toEqual({
      status: 'timed_out',
      reasonCode: 'timeout',
    });
    expect(classifyToolExecutionFailure(new SubagentDelegationError('a', 'ABORTED'))).toEqual({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
    expect(
      classifyToolExecutionFailure(new SubagentDelegationError('i', 'INVALID_AGENT_ID'))
    ).toEqual({ status: 'failed', reasonCode: 'validation_failed' });
    expect(classifyToolExecutionFailure(new SubagentDelegationError('m', 'MAX_CALLS'))).toEqual({
      status: 'failed',
      reasonCode: 'not_allowed',
    });
  });

  it('falls back to a plain execution failure for unknown errors', () => {
    expect(classifyToolExecutionFailure(new Error('anything'))).toEqual({
      status: 'failed',
      reasonCode: 'execution_error',
    });
  });
});

describe('subagentStatusToTerminal', () => {
  it('maps every subagent status to a shared terminal state', () => {
    expect(subagentStatusToTerminal('completed')).toEqual({ status: 'succeeded' });
    expect(subagentStatusToTerminal('failed')).toEqual({
      status: 'failed',
      reasonCode: 'execution_error',
    });
    expect(subagentStatusToTerminal('aborted')).toEqual({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
    expect(subagentStatusToTerminal('timeout')).toEqual({
      status: 'timed_out',
      reasonCode: 'timeout',
    });
  });
});

describe('classifyToolExecutionSource', () => {
  it('classifies by naming convention', () => {
    expect(classifyToolExecutionSource('mcp__files__read')).toBe('mcp');
    expect(classifyToolExecutionSource('delegate_to_agent')).toBe('subagent');
    expect(classifyToolExecutionSource('skill')).toBe('skill');
    expect(classifyToolExecutionSource('bash')).toBe('builtin');
  });
});

describe('ToolExecutionLifecycle', () => {
  it('emits one event per accepted transition and swallows invalid edges', () => {
    const events: ToolExecutionTransitionEvent[] = [];
    const lifecycle = new ToolExecutionLifecycle('call-1', 'read_file', (event) =>
      events.push(event)
    );
    lifecycle.emitQueued();
    lifecycle.transition('running');
    lifecycle.transition('succeeded');
    // Terminal state is immutable; later signals are ignored.
    lifecycle.transition('failed', 'execution_error');
    lifecycle.transition('running');

    expect(events.map((event) => event.execution.status)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
    expect(lifecycle.current.status).toBe('succeeded');
    expect(lifecycle.current.durationMs).toBeGreaterThanOrEqual(0);
    expect(events.every((event) => event.callId === 'call-1' && event.name === 'read_file')).toBe(
      true
    );
  });

  it('supports the awaiting_user round trip', () => {
    const lifecycle = new ToolExecutionLifecycle('call-2', 'mcp__demo__ask');
    lifecycle.transition('running');
    lifecycle.transition('awaiting_user');
    expect(lifecycle.current.status).toBe('awaiting_user');
    expect(lifecycle.current.awaitingUserAt).toBeDefined();
    lifecycle.transition('running');
    lifecycle.transition('succeeded');
    expect(lifecycle.current.status).toBe('succeeded');
    expect(lifecycle.current.source).toBe('mcp');
  });
});
