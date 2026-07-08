import { describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  extractMcpMediaCandidates,
  MCP_MEDIA_MAX_BYTES,
  type McpMediaStorage,
  persistMcpMediaParts,
} from '../../../../src/services/mcp/rich-content';
import type { McpContentBlock } from '../../../../src/services/mcp/types';

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');
const PDF_BASE64 = Buffer.from('fake-pdf-bytes').toString('base64');

function mediaContext() {
  return {
    db: getDb(),
    userId: 'user-mcp-media',
    chatId: 'chat-mcp-media',
    toolCallId: 'call-1',
    serverSlug: 'charts',
    toolName: 'render',
  };
}

function recordingStorage() {
  const saved: Array<{ kind: 'image' | 'file'; mimeType: string; bytes: number }> = [];
  const storage: McpMediaStorage = {
    saveImage: ({ data, mimeType }) => {
      saved.push({ kind: 'image', mimeType, bytes: data.byteLength });
      return Promise.resolve(`/images/mcp-${saved.length}.png`);
    },
    saveFile: ({ data, mimeType }) => {
      saved.push({ kind: 'file', mimeType, bytes: data.byteLength });
      return Promise.resolve(`/uploads/chat/mcp-${saved.length}.pdf`);
    },
  };
  return { saved, storage };
}

describe('extractMcpMediaCandidates', () => {
  it('selects image blocks and allowlisted blob resources', () => {
    const blocks: McpContentBlock[] = [
      { type: 'text', text: 'caption' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      { type: 'resource', uri: 'file:///notes.md', mimeType: 'text/markdown', text: 'inline' },
      { type: 'resource', uri: 'file:///chart.webp', mimeType: 'image/webp', blob: PNG_BASE64 },
      { type: 'resource', uri: 'file:///doc.pdf', mimeType: 'application/pdf', blob: PDF_BASE64 },
    ];

    expect(extractMcpMediaCandidates(blocks)).toEqual([
      { kind: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      { kind: 'image', data: PNG_BASE64, mimeType: 'image/webp', uri: 'file:///chart.webp' },
      {
        kind: 'file',
        data: PDF_BASE64,
        mimeType: 'application/pdf',
        extension: 'pdf',
        fileKind: 'pdf',
        uri: 'file:///doc.pdf',
      },
    ]);
  });

  it('skips audio, disallowed mimes, and image blocks outside the allowlist', () => {
    const blocks: McpContentBlock[] = [
      { type: 'audio', data: PNG_BASE64, mimeType: 'audio/wav' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/svg+xml' },
      { type: 'resource', uri: 'file:///a.zip', mimeType: 'application/zip', blob: PDF_BASE64 },
      { type: 'resource', uri: 'file:///no-mime', blob: PDF_BASE64 },
      { type: 'unknown', blockType: 'video' },
    ];

    expect(extractMcpMediaCandidates(blocks)).toEqual([]);
  });
});

describe('persistMcpMediaParts', () => {
  it('persists a mixed result and stamps provenance on every part', async () => {
    const { saved, storage } = recordingStorage();
    const parts = await persistMcpMediaParts(
      [
        { type: 'text', text: 'caption' },
        { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
        { type: 'resource', uri: 'file:///doc.pdf', mimeType: 'application/pdf', blob: PDF_BASE64 },
      ],
      mediaContext(),
      storage
    );

    expect(parts).toEqual([
      {
        type: 'mcp_media',
        toolCallId: 'call-1',
        serverSlug: 'charts',
        toolName: 'render',
        kind: 'image',
        mimeType: 'image/png',
        url: '/images/mcp-1.png',
      },
      {
        type: 'mcp_media',
        toolCallId: 'call-1',
        serverSlug: 'charts',
        toolName: 'render',
        kind: 'resource',
        mimeType: 'application/pdf',
        url: '/uploads/chat/mcp-2.pdf',
        uri: 'file:///doc.pdf',
      },
    ]);
    expect(saved).toEqual([
      { kind: 'image', mimeType: 'image/png', bytes: 14 },
      { kind: 'file', mimeType: 'application/pdf', bytes: 14 },
    ]);
  });

  it('skips blocks above the size cap without failing the others', async () => {
    const { saved, storage } = recordingStorage();
    const oversized = Buffer.alloc(MCP_MEDIA_MAX_BYTES + 1).toString('base64');

    const parts = await persistMcpMediaParts(
      [
        { type: 'image', data: oversized, mimeType: 'image/png' },
        { type: 'image', data: PNG_BASE64, mimeType: 'image/jpeg' },
      ],
      mediaContext(),
      storage
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' });
    expect(saved).toEqual([{ kind: 'image', mimeType: 'image/jpeg', bytes: 14 }]);
  });

  it('skips a block whose storage write fails and keeps the rest', async () => {
    const storage: McpMediaStorage = {
      saveImage: ({ mimeType }) =>
        mimeType === 'image/png'
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve('/images/ok.webp'),
      saveFile: () => Promise.reject(new Error('unreachable')),
    };

    const parts = await persistMcpMediaParts(
      [
        { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
        { type: 'image', data: PNG_BASE64, mimeType: 'image/webp' },
      ],
      mediaContext(),
      storage
    );

    expect(parts).toEqual([
      {
        type: 'mcp_media',
        toolCallId: 'call-1',
        serverSlug: 'charts',
        toolName: 'render',
        kind: 'image',
        mimeType: 'image/webp',
        url: '/images/ok.webp',
      },
    ]);
  });

  it('returns no parts for empty or text-only content', async () => {
    const { saved, storage } = recordingStorage();

    expect(await persistMcpMediaParts([], mediaContext(), storage)).toEqual([]);
    expect(
      await persistMcpMediaParts([{ type: 'text', text: 'plain' }], mediaContext(), storage)
    ).toEqual([]);
    expect(saved).toEqual([]);
  });
});
