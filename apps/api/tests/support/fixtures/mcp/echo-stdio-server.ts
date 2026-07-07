/**
 * Standalone stdio MCP server for spawn/teardown integration tests.
 * // Usage: spawned as `bun echo-stdio-server.ts` by StdioClientTransport.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEchoMcpServer } from './create-echo-mcp-server';

await createEchoMcpServer().connect(new StdioServerTransport());
