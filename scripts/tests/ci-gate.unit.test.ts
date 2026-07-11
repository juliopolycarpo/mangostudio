import { describe, expect, test } from 'bun:test';

import { evaluateGate, parseAllowedSkips, parseNeeds } from '../ci/evaluate-gate';

// Accept/reject policy for the aggregate gate jobs; the workflow-level
// wiring is pinned by the policy tests added alongside the gate jobs.

describe('gate result evaluation', () => {
  const skips = parseAllowedSkips('qa-metrics');

  test('passes when every dependency succeeded', () => {
    const verdict = evaluateGate({ check: 'success', test: 'success' }, new Set());
    expect(verdict.ok).toBe(true);
  });

  test.each([
    'failure',
    'cancelled',
    'skipped',
  ] as const)('fails when a mandatory dependency result is %s', (result) => {
    const verdict = evaluateGate({ check: 'success', test: result }, new Set());
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join('\n')).toContain(`test: ${result}`);
  });

  test('accepts a skip only for a declared conditional lane', () => {
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'skipped' }, skips).ok).toBe(true);
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'skipped' }, new Set()).ok).toBe(false);
  });

  test('a declared conditional lane that ran and failed still fails the gate', () => {
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'failure' }, skips).ok).toBe(false);
  });

  test('one failure is not masked by other successes or accepted skips', () => {
    const verdict = evaluateGate(
      { check: 'success', test: 'failure', 'qa-metrics': 'skipped' },
      skips
    );
    expect(verdict.ok).toBe(false);
  });

  test('an empty needs context fails instead of passing vacuously', () => {
    expect(evaluateGate({}, new Set()).ok).toBe(false);
  });

  test('an allowed-skip job that is not a dependency is configuration drift', () => {
    const verdict = evaluateGate({ check: 'success' }, parseAllowedSkips('renamed-job'));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join('\n')).toContain('renamed-job');
  });

  test('parseAllowedSkips splits on whitespace and commas and drops empties', () => {
    expect(parseAllowedSkips(' a  b,c ')).toEqual(new Set(['a', 'b', 'c']));
    expect(parseAllowedSkips('')).toEqual(new Set());
    expect(parseAllowedSkips(undefined)).toEqual(new Set());
  });

  test('parseNeeds reads the toJSON(needs) shape and rejects malformed input', () => {
    expect(parseNeeds('{"check":{"result":"success","outputs":{}}}')).toEqual({
      check: 'success',
    });
    expect(() => parseNeeds(undefined)).toThrow('NEEDS is required');
    expect(() => parseNeeds('not json')).toThrow('not valid JSON');
    expect(() => parseNeeds('[]')).toThrow('JSON object form');
    expect(() => parseNeeds('{"check":{}}')).toThrow('unrecognized result');
    expect(() => parseNeeds('{"check":{"result":"green"}}')).toThrow('unrecognized result');
  });
});
