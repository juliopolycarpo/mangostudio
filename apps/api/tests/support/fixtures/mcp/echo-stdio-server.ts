/**
 * Standalone stdio MCP server for spawn/teardown integration tests.
 * // Usage: spawned as `bun echo-stdio-server.ts` by StdioClientTransport.
 */

import { writeFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEchoMcpServer } from './create-echo-mcp-server';

const pidFile = process.env.MCP_FIXTURE_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8');

await createEchoMcpServer().connect(new StdioServerTransport());
