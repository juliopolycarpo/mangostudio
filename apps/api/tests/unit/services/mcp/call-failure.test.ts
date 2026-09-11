import { describe, expect, it } from 'bun:test';
import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import { classifyMcpCallFailure } from '../../../../src/services/mcp/call-failure';
import { ToolExecutionTimedOutError } from '../../../../src/services/tools/execution-timeout';

describe('classifyMcpCallFailure', () => {
  it('maps the hub deadline to timeout', () => {
    expect(classifyMcpCallFailure(new ToolExecutionTimedOutError('slow'))).toBe('timeout');
  });

  it('treats a dead runtime as server_closed', () => {
    expect(classifyMcpCallFailure(new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'gone'))).toBe(
      'server_closed'
    );
  });

  it('treats mcp_session_missing as server_closed', () => {
    expect(
      classifyMcpCallFailure(
        new RemoteError('INTERNAL', 'no session', { kind: 'mcp_session_missing' })
      )
    ).toBe('server_closed');
  });

  it('reads mcpFailure details from the runtime', () => {
    expect(
      classifyMcpCallFailure(new RemoteError('INTERNAL', 'timed out', { mcpFailure: 'timeout' }))
    ).toBe('timeout');
    expect(
      classifyMcpCallFailure(new RemoteError('INTERNAL', 'closed', { mcpFailure: 'server_closed' }))
    ).toBe('server_closed');
  });

  it('falls back to other for unknown failures', () => {
    expect(classifyMcpCallFailure(new Error('boom'))).toBe('other');
    expect(classifyMcpCallFailure(new RemoteError('INTERNAL', 'boom'))).toBe('other');
  });
});
