import { describe, expect, it } from 'bun:test';
import {
  capMcpResultText,
  flattenMcpContent,
  MCP_RESULT_MAX_BYTES,
  MCP_RESULT_TRUNCATION_MARKER,
  normalizeMcpContent,
} from '../../../../src/services/mcp/content-mapping';

describe('normalizeMcpContent', () => {
  it('maps text, image, audio, and resource blocks to the project shapes', () => {
    const blocks = normalizeMcpContent([
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
      {
        type: 'resource',
        resource: { uri: 'file:///notes.md', mimeType: 'text/markdown', text: 'notes' },
      },
      {
        type: 'resource',
        resource: { uri: 'file:///doc.pdf', mimeType: 'application/pdf', blob: 'aGk=' },
      },
    ]);

    expect(blocks).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
      { type: 'resource', uri: 'file:///notes.md', mimeType: 'text/markdown', text: 'notes' },
      { type: 'resource', uri: 'file:///doc.pdf', mimeType: 'application/pdf', blob: 'aGk=' },
    ]);
  });

  it('degrades malformed blocks to unknown instead of throwing', () => {
    const blocks = normalizeMcpContent([
      { type: 'text', text: 42 },
      { type: 'image', mimeType: 'image/png' },
      { type: 'resource', resource: { mimeType: 'text/plain' } },
      { type: 'video', mimeType: 'video/mp4' },
    ]);

    expect(blocks).toEqual([
      { type: 'unknown', blockType: 'text' },
      { type: 'unknown', blockType: 'image', mimeType: 'image/png' },
      { type: 'unknown', blockType: 'resource' },
      { type: 'unknown', blockType: 'video', mimeType: 'video/mp4' },
    ]);
  });
});

describe('flattenMcpContent', () => {
  it('joins text blocks with blank lines', () => {
    const text = flattenMcpContent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);

    expect(text).toBe('first\n\nsecond');
  });

  it('inlines text-bearing resources and notes rich or binary blocks', () => {
    const text = flattenMcpContent([
      { type: 'text', text: 'caption' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      { type: 'audio', data: 'aGk=', mimeType: 'audio/wav' },
      {
        type: 'resource',
        uri: 'file:///notes.md',
        mimeType: 'text/markdown',
        text: 'inline notes',
      },
      { type: 'resource', uri: 'file:///doc.pdf', mimeType: 'application/pdf', blob: 'aGk=' },
      { type: 'unknown', blockType: 'video' },
    ]);

    expect(text).toBe(
      [
        'caption',
        '[image content, image/png]',
        '[audio content, audio/wav]',
        'inline notes',
        '[binary resource file:///doc.pdf, application/pdf]',
        '[unsupported video content]',
      ].join('\n\n')
    );
  });

  it('returns an empty string for empty content', () => {
    expect(flattenMcpContent([])).toBe('');
  });
});

describe('capMcpResultText', () => {
  it('passes text at the cap through untouched', () => {
    const text = 'a'.repeat(MCP_RESULT_MAX_BYTES);
    expect(capMcpResultText(text)).toBe(text);
  });

  it('caps oversized text and appends the truncation marker', () => {
    const capped = capMcpResultText('a'.repeat(MCP_RESULT_MAX_BYTES + 1));

    expect(capped).toBe('a'.repeat(MCP_RESULT_MAX_BYTES) + MCP_RESULT_TRUNCATION_MARKER);
  });

  it('never cuts through a multi-byte character', () => {
    // é is 2 bytes in UTF-8; an odd byte budget forces a mid-character cut.
    const capped = capMcpResultText('é'.repeat(MCP_RESULT_MAX_BYTES));

    expect(capped.endsWith(MCP_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(capped).not.toContain('�');
  });

  it('applies the cap through flattenMcpContent', () => {
    const text = flattenMcpContent([{ type: 'text', text: 'x'.repeat(MCP_RESULT_MAX_BYTES * 2) }]);

    expect(text.endsWith(MCP_RESULT_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
      MCP_RESULT_MAX_BYTES + MCP_RESULT_TRUNCATION_MARKER.length
    );
  });
});
