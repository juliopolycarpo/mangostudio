import { describe, expect, it } from 'bun:test';

import { breakEvenMbps, buildTranscriptRows, transferMs } from '../bench/api-json-compression';

describe('api-json-compression benchmark helpers', () => {
  it('finds the link speed where saved transfer time equals the CPU cost', () => {
    // 500 KB saved for 4 ms: 500_000 * 8 bits / 4 ms = 1 Gbit/s.
    expect(breakEvenMbps(500_000, 4)).toBe(1000);
    // At that speed the saved bytes take exactly the compression cost to send.
    expect(transferMs(500_000, breakEvenMbps(500_000, 4))).toBe(4);
  });

  it('reports no break-even when compression saved nothing', () => {
    expect(breakEvenMbps(0, 3)).toBe(0);
    expect(breakEvenMbps(-10, 3)).toBe(0);
  });

  it('refuses a non-positive cost instead of dividing by it', () => {
    expect(() => breakEvenMbps(1000, 0)).toThrow('expected a positive cost in ms | received: 0');
  });

  it('builds the same transcript for the same corpus and seed', () => {
    const corpus = ['const a = 1;\n'.repeat(500), 'export function b() {}\n'.repeat(400)];
    const first = buildTranscriptRows(corpus, 10, 7);
    const second = buildTranscriptRows(corpus, 10, 7);
    // Tool call ids are random; the sizes and roles are what must repeat.
    const shape = (rows: typeof first) =>
      rows.map((row) => [row.role, row.text.length, row.parts?.length ?? 0]);
    expect(shape(first)).toEqual(shape(second));
  });

  it('alternates user prompts and assistant turns with tool results', () => {
    const rows = buildTranscriptRows(['x'.repeat(5000)], 6, 3);
    expect(rows.map((row) => row.role)).toEqual(['user', 'ai', 'user', 'ai', 'user', 'ai']);
    const parts = JSON.parse(rows[1]?.parts as string) as Array<{ type: string }>;
    expect(parts.some((part) => part.type === 'tool_result')).toBe(true);
  });

  it('refuses an empty corpus', () => {
    expect(() => buildTranscriptRows([], 2, 1)).toThrow(
      'expected a non-empty corpus | received: []'
    );
  });
});
