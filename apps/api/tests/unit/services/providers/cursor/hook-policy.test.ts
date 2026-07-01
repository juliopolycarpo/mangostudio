import { describe, expect, it } from 'bun:test';
import {
  CURSOR_CUSTOM_USER_TOOLS_SERVER,
  evaluateCursorBuiltinToolHook,
  isCustomUserToolsMcpCall,
} from '../../../../../src/services/providers/cursor/hook-policy';

describe('cursor hook policy', () => {
  it('allows custom-user-tools MCP calls', () => {
    expect(
      isCustomUserToolsMcpCall({
        provider_identifier: CURSOR_CUSTOM_USER_TOOLS_SERVER,
        tool_name: 'bash',
      })
    ).toBe(true);
    expect(
      isCustomUserToolsMcpCall({
        providerIdentifier: CURSOR_CUSTOM_USER_TOOLS_SERVER,
      })
    ).toBe(true);
    expect(
      isCustomUserToolsMcpCall({
        tool_name: `MCP:${CURSOR_CUSTOM_USER_TOOLS_SERVER}:read_file`,
      })
    ).toBe(true);
  });

  it('denies built-in shell, read, and write tool calls', () => {
    for (const payload of [
      { tool_name: 'Shell' },
      { tool_name: 'Read' },
      { tool_name: 'Write' },
      { tool_name: 'Grep' },
      { command: 'ls -la' },
    ]) {
      expect(evaluateCursorBuiltinToolHook(payload)).toEqual({
        permission: 'deny',
        user_message: expect.any(String),
        agent_message: expect.any(String),
      });
    }
  });

  it('allows only custom-user-tools through evaluateCursorBuiltinToolHook', () => {
    expect(
      evaluateCursorBuiltinToolHook({
        mcp_server: CURSOR_CUSTOM_USER_TOOLS_SERVER,
        name: 'read_file',
      })
    ).toEqual({ permission: 'allow' });
  });
});
