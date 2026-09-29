// parseJunitXml decides whether a report is demonstrably whole. A cut-off
// report used to count fewer <testcase>s and raise no signal at all.

import { describe, expect, it } from 'bun:test';

import { parseJunitXml } from './junit-results';
import { junitXml, passingCases, truncatedJunitXml } from './testing/junit-fixture';

describe('parseJunitXml completeness', () => {
  it('accepts a whole report', () => {
    const parsed = parseJunitXml(junitXml(passingCases(5)));

    expect(parsed.truncated).toBeNull();
    expect(parsed.tests).toBe(5);
  });

  it('flags a report with no closing </testsuites>', () => {
    const xml = junitXml(passingCases(5));
    const parsed = parseJunitXml(xml.slice(0, xml.indexOf('</testsuites>')));

    expect(parsed.truncated).toBe('no closing </testsuites>');
  });

  it('flags a report cut inside a testcase element and keeps the readable prefix', () => {
    const cases = [
      ...passingCases(3),
      { name: 'cut', outcome: 'fail' as const, message: 'never finished' },
    ];
    const xml = junitXml(cases);
    const parsed = parseJunitXml(xml.slice(0, xml.indexOf('never finished')));

    expect(parsed.truncated).toBe('a testcase element was cut off');
    expect(parsed.tests).toBeGreaterThanOrEqual(3);
  });

  it('flags a header that declares more tests than the body holds', () => {
    // A writer that emitted the header but lost a whole <testsuite> block.
    const xml = junitXml(passingCases(6)).replace('tests="6"', 'tests="9"');

    expect(parseJunitXml(xml).truncated).toBe('header declares 9 tests but 6 testcases were found');
  });

  it('flags a zero-byte file rather than counting it as an empty lane', () => {
    expect(parseJunitXml('').truncated).toBe('no closing </testsuites>');
  });

  it('reads a truncation at any offset as incomplete, never as complete', () => {
    const cases = [...passingCases(4), { name: 'bad', outcome: 'fail' as const }];
    const whole = junitXml(cases);
    for (let keep = 0; keep < whole.length; keep += 17) {
      const parsed = parseJunitXml(truncatedJunitXml(cases, keep));
      expect(
        parsed.truncated,
        `truncated at ${keep} of ${whole.length} chars was reported complete`
      ).not.toBeNull();
    }
  });

  it('counts todo separately from skipped', () => {
    const parsed = parseJunitXml(
      junitXml([
        { name: 'a' },
        { name: 'b', outcome: 'skip' },
        { name: 'c', outcome: 'todo' },
        { name: 'd', outcome: 'fail' },
      ])
    );

    expect(parsed).toMatchObject({ tests: 4, passed: 1, skipped: 1, todo: 1, failed: 1 });
  });

  it('keeps rows that share file, title and line as separate cases inside one report', () => {
    const rows = [
      { name: 'row', line: 7 },
      { name: 'row', line: 7 },
    ];

    expect(parseJunitXml(junitXml(rows)).cases).toHaveLength(2);
  });
});
