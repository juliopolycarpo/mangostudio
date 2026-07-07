import { describe, expect, it } from 'bun:test';
import {
  capMcpResultText,
  flattenMcpContent,
  MCP_RESULT_MAX_BYTES,
  MCP_RESULT_TRUNCATION_MARKER,
} from '../../../../src/services/mcp/content-mapping';

describe('flattenMcpContent', () => {
  it('joins text blocks with blank lines', () => {
    const text = flattenMcpContent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);

    expect(text).toBe('first\n\nsecond');
  });

  it('replaces rich media blocks with a placeholder note', () => {
    const text = flattenMcpContent([
      { type: 'text', text: 'caption' },
      { type: 'image', mimeType: 'image/png' },
      { type: 'audio', mimeType: 'audio/wav' },
      { type: 'resource' },
    ]);

    expect(text).toBe(
      [
        'caption',
        '[unsupported image content, image/png]',
        '[unsupported audio content, audio/wav]',
        '[unsupported resource content]',
      ].join('\n\n')
    );
  });

  it('treats a text block without a string payload as unsupported', () => {
    expect(flattenMcpContent([{ type: 'text', text: 42 }])).toBe('[unsupported text content]');
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
