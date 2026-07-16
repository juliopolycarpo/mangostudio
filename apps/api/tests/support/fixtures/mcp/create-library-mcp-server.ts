/**
 * Shared MCP test server for the resources and prompts primitives: a text and
 * a binary resource, plus prompts with and without arguments. Complements the
 * tools-only echo fixture so capability gating is testable in both directions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const LIBRARY_NOTES_URI = 'file:///library/notes.md';
export const LIBRARY_NOTES_TEXT = '# Notes\n\nremember the mango';
export const LIBRARY_REPORT_URI = 'file:///library/report.pdf';
const LIBRARY_REPORT_BASE64 = Buffer.from('library-pdf-bytes').toString('base64');

export function createLibraryMcpServer(): Server {
  const server = new Server(
    { name: 'library-fixture', version: '1.0.0' },
    { capabilities: { resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: LIBRARY_NOTES_URI,
        name: 'notes',
        description: 'Project notes.',
        mimeType: 'text/markdown',
        size: LIBRARY_NOTES_TEXT.length,
      },
      { uri: LIBRARY_REPORT_URI, name: 'report', mimeType: 'application/pdf' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    if (request.params.uri === LIBRARY_NOTES_URI) {
      return {
        contents: [{ uri: LIBRARY_NOTES_URI, mimeType: 'text/markdown', text: LIBRARY_NOTES_TEXT }],
      };
    }
    if (request.params.uri === LIBRARY_REPORT_URI) {
      return {
        contents: [
          { uri: LIBRARY_REPORT_URI, mimeType: 'application/pdf', blob: LIBRARY_REPORT_BASE64 },
        ],
      };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
  });

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: 'summarize',
        description: 'Summarize a topic.',
        arguments: [{ name: 'topic', description: 'What to summarize.', required: true }],
      },
      { name: 'greet', description: 'A fixed greeting.' },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    if (request.params.name === 'summarize') {
      const topic = request.params.arguments?.topic ?? '';
      return {
        description: 'Summarize a topic.',
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: `Summarize ${topic}.` },
          },
        ],
      };
    }
    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'Hello!' } }],
    };
  });

  return server;
}
