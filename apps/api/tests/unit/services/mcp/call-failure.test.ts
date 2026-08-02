import { describe, expect, it } from 'bun:test';
import { RuntimeRemoteError } from '@mangostudio/runtime';
import { classifyMcpCallFailure } from '../../../../src/services/mcp/call-failure';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';

describe('classifyMcpCallFailure', () => {
  it('maps the hub deadline to timeout', () => {
    expect(classifyMcpCallFailure(new ToolExecutionTimedOutError('slow'))).toBe('timeout');
  });

  it('treats a dead runtime as server_closed', () => {
    expect(classifyMcpCallFailure(new RuntimeRemoteError('RUNTIME_UNAVAILABLE', 'gone'))).toBe(
      'server_closed'
    );
  });

  it('treats mcp_session_missing as server_closed', () => {
    expect(
      classifyMcpCallFailure(
        new RuntimeRemoteError('INTERNAL', 'no session', { kind: 'mcp_session_missing' })
      )
    ).toBe('server_closed');
  });

  it('reads mcpFailure details from the runtime', () => {
    expect(
      classifyMcpCallFailure(
        new RuntimeRemoteError('INTERNAL', 'timed out', { mcpFailure: 'timeout' })
      )
    ).toBe('timeout');
    expect(
      classifyMcpCallFailure(
        new RuntimeRemoteError('INTERNAL', 'closed', { mcpFailure: 'server_closed' })
      )
    ).toBe('server_closed');
  });

  it('falls back to other for unknown failures', () => {
    expect(classifyMcpCallFailure(new Error('boom'))).toBe('other');
    expect(classifyMcpCallFailure(new RuntimeRemoteError('INTERNAL', 'boom'))).toBe('other');
  });
});
