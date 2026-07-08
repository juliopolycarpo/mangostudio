import type { McpClientHandle } from '../../../../src/services/mcp/types';

/**
 * Minimal in-memory McpClientHandle for unit tests; override only the members
 * a test cares about so interface growth stays contained to this fixture.
 *
 * // Usage: makeFakeMcpHandle({ listTools: () => Promise.resolve(tools) })
 */
export function makeFakeMcpHandle(overrides: Partial<McpClientHandle> = {}): McpClientHandle {
  return {
    getCapabilities: () => ({ tools: true, resources: false, prompts: false }),
    listTools: () => Promise.resolve([]),
    callTool: () =>
      Promise.resolve({ contentText: '', isError: false, rawContentKinds: [], content: [] }),
    listResources: () => Promise.resolve([]),
    readResource: () => Promise.resolve([]),
    listPrompts: () => Promise.resolve([]),
    getPrompt: () => Promise.resolve({ messages: [] }),
    close: () => Promise.resolve(),
    ...overrides,
  };
}
