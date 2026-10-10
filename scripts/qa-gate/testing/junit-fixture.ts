// Test-only builders for the artifacts a test job leaves behind: Bun-shaped
// JUnit XML, receipts, and an in-memory filesystem that answers the collector's
// `ReadText` port. Named fakes, so a failure-mode test states what is missing
// instead of stubbing a reader inline.

import { normalize } from 'node:path';

import type { ReadText } from '../results/evidence';

export interface FixtureCase {
  readonly name: string;
  readonly file?: string;
  readonly classname?: string;
  readonly line?: number;
  readonly outcome?: 'pass' | 'fail' | 'skip' | 'todo';
  readonly message?: string;
}

const attr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const caseXml = (testCase: FixtureCase, index: number): string => {
  const file = testCase.file ?? 'a.test.ts';
  const line = testCase.line ?? index + 1;
  const open = `<testcase name="${attr(testCase.name)}" classname="${attr(testCase.classname ?? '')}" time="0" file="${file}" line="${line}" assertions="0"`;
  switch (testCase.outcome ?? 'pass') {
    case 'fail':
      return `${open}>\n<failure type="AssertionError" message="${attr(testCase.message ?? 'boom')}">trace</failure>\n</testcase>`;
    case 'skip':
      return `${open}>\n<skipped />\n</testcase>`;
    case 'todo':
      return `${open}>\n<skipped message="TODO" />\n</testcase>`;
    default:
      return `${open} />`;
  }
};

/**
 * A complete Bun-shaped report whose `tests` header agrees with its cases.
 * // Usage: junitXml([{ name: 'ok' }, { name: 'bad', outcome: 'fail' }])
 */
export const junitXml = (cases: readonly FixtureCase[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="bun test" tests="${cases.length}" assertions="0" failures="0" skipped="0" time="0">`,
    '<testsuite name="a.test.ts" file="a.test.ts">',
    ...cases.map(caseXml),
    '</testsuite>',
    '</testsuites>',
  ].join('\n');

/** The same report cut off `keep` characters in, as a killed writer leaves it. */
export const truncatedJunitXml = (cases: readonly FixtureCase[], keep: number): string =>
  junitXml(cases).slice(0, keep);

/** `n` distinct passing cases named `<prefix>-<i>`. */
export const passingCases = (count: number, prefix = 't'): FixtureCase[] =>
  Array.from({ length: count }, (_, index) => ({ name: `${prefix}-${index}` }));

/** A `shard-meta.json` body as the watchdog writes it. */
export const receiptJson = (shard: number | string, exitCode: number): string =>
  `${JSON.stringify({ shard, exitCode, durationSeconds: 40 })}\n`;

/**
 * In-memory files keyed by normalized native path; a path not present reads
 * as missing, exactly like a job that never uploaded it. Records the original
 * read paths so a test can assert the adapter consumed existing files and nothing else.
 * // Usage: const fs = fakeFiles({ 'shards/test-shard-1/shard-meta.json': receiptJson(1, 0) })
 */
export const fakeFiles = (
  files: Readonly<Record<string, string>>
): { readonly readText: ReadText; readonly reads: string[] } => {
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, text]) => [normalize(path), text])
  );
  const reads: string[] = [];
  return {
    reads,
    readText: (path) => {
      reads.push(path);
      return Promise.resolve(normalizedFiles.get(normalize(path)) ?? null);
    },
  };
};
