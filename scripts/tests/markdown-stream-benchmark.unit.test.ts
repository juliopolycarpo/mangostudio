import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

import {
  buildMixedAnswer,
  buildPrefixes,
  loadModules,
  measurePhases,
  median,
  runPass,
  STRATEGIES,
  summarizeChunkTimes,
} from '../bench/markdown-stream';

const frontendDir = resolve(import.meta.dir, '../../apps/frontend');

describe('buildMixedAnswer', () => {
  it('is at least the requested length and uses every block kind the renderer handles', () => {
    const answer = buildMixedAnswer(5000);

    expect(answer.length).toBeGreaterThanOrEqual(5000);
    for (const marker of [
      '## ',
      '- item',
      '1. ordered',
      '| --- |',
      '```ts',
      '> Note',
      '[guide](',
    ]) {
      expect(answer).toContain(marker);
    }
  });
});

describe('buildPrefixes', () => {
  it('returns the requested count of growing prefixes that ends with the whole text', () => {
    const text = 'abcdefghij'.repeat(7);
    const prefixes = buildPrefixes(text, 5);

    expect(prefixes).toHaveLength(5);
    expect(prefixes.at(-1)).toBe(text);
    prefixes.forEach((prefix, index) => {
      expect(text.startsWith(prefix)).toBe(true);
      if (index > 0) expect(prefix.length).toBeGreaterThan(prefixes[index - 1]?.length ?? Infinity);
    });
  });
});

describe('median', () => {
  it('takes the middle value, and the mean of the two middle values for an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('summarizeChunkTimes', () => {
  it('reports total, median, p95, worst and the first and last windows', () => {
    const times = Array.from({ length: 100 }, (_, index) => index + 1);
    const summary = summarizeChunkTimes('whole', 1234, times);

    expect(summary).toMatchObject({
      strategy: 'whole',
      chunks: 100,
      chars: 1234,
      totalMs: 5050,
      medianMs: 50.5,
      p95Ms: 96,
      worstMs: 100,
      firstMeanMs: 25.5,
      lastMeanMs: 75.5,
    });
  });
});

describe('runPass and measurePhases', () => {
  it('times every chunk for both strategies, and both agree with a whole parse', async () => {
    const modules = await loadModules(frontendDir);
    const prefixes = buildPrefixes(buildMixedAnswer(4000), 30);

    for (const strategy of STRATEGIES) {
      // runPass compares with a whole parse every 25th chunk and at the end, and exits on a mismatch.
      expect(runPass(modules, strategy, prefixes)).toHaveLength(30);
    }
    const phases = measurePhases(modules, prefixes);
    expect(phases.lexMs).toBeGreaterThan(0);
    expect(phases.renderMs).toBeGreaterThan(0);
    expect(phases.languageScanMs).toBeGreaterThan(0);
  });
});
