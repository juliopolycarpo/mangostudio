// Count test outcomes from the JUnit XML each lane writes, and fold the
// per-shard files back into one per-workspace tally.
//
// This replaces parsing the runner log. Counts come from `<testcase>` elements
// rather than the `<testsuites>` header, because producers disagree on the
// header: Bun emits `tests`/`assertions`/`failures`/`skipped` there, while the
// classic dialect (Vitest's, among others) puts `skipped` only on the nested
// `<testsuite>` — which Bun also nests, once per `describe`, so summing those
// double-counts. A `<testcase>` is a leaf in every dialect.
//
// What JUnit cannot carry is unhandled errors: Bun's `# Unhandled error
// between tests` block leaves the report at `failures="0"` with no failing
// case while the run exits 1. Those counts and headlines come from
// ./unhandled-errors.ts instead.

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../lib/config';
import { TEST_LANES, type TestLane } from '../lib/test-lanes';
import type { TestErrorHeadline, TestSuiteStats } from './collect/types';
import type { UnhandledErrors } from './unhandled-errors';

const MAX_HEADLINES = 5;
const MAX_HEADLINE_CHARS = 400;

export interface JunitCounts {
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** Distinct files owning at least one failing case. */
  readonly failedFiles: readonly string[];
  readonly headlines: readonly TestErrorHeadline[];
}

const EMPTY_COUNTS: JunitCounts = {
  tests: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
  failedFiles: [],
  headlines: [],
};

const NUMERIC_ENTITY_RE = /&#(\d+);/g;
const HEX_ENTITY_RE = /&#x([0-9a-fA-F]+);/g;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/** Decode the entity set both reporters emit. `&amp;` runs last so `&amp;lt;` stays literal. */
const decodeXmlEntities = (value: string): string => {
  let out = value;
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) out = out.split(entity).join(char);
  out = out.replace(NUMERIC_ENTITY_RE, (_, code: string) => String.fromCodePoint(Number(code)));
  out = out.replace(HEX_ENTITY_RE, (_, code: string) =>
    String.fromCodePoint(Number.parseInt(code, 16))
  );
  return out.split('&amp;').join('&');
};

const ATTRIBUTE_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

const readAttributes = (openTag: string): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {};
  for (const match of openTag.matchAll(ATTRIBUTE_RE)) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
};

/**
 * Find the index just past the `>` closing the tag that starts at `start`.
 * Quoted attribute values are skipped so an escaped `>` inside one cannot end
 * the tag early. Returns -1 when the tag is unterminated.
 */
const endOfOpenTag = (xml: string, start: number): number => {
  let inQuote = false;
  for (let index = start; index < xml.length; index++) {
    const char = xml[index];
    if (char === '"') inQuote = !inQuote;
    else if (char === '>' && !inQuote) return index + 1;
  }
  return -1;
};

const clip = (text: string): string =>
  text.length <= MAX_HEADLINE_CHARS ? text : `${text.slice(0, MAX_HEADLINE_CHARS - 1)}…`;

/**
 * Count outcomes and collect failure headlines from one JUnit document.
 * // Usage: parseJunitXml(await Bun.file('.mango/artifacts/junit/api.xml').text());
 */
export const parseJunitXml = (xml: string): JunitCounts => {
  let tests = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failedFiles = new Set<string>();
  const headlines: TestErrorHeadline[] = [];
  const seen = new Set<string>();

  let cursor = 0;
  while (true) {
    const open = xml.indexOf('<testcase', cursor);
    if (open === -1) break;

    const openEnd = endOfOpenTag(xml, open);
    if (openEnd === -1) break;

    const openTag = xml.slice(open, openEnd);
    const attributes = readAttributes(openTag);
    const selfClosing = openTag.endsWith('/>');

    let body = '';
    if (selfClosing) {
      cursor = openEnd;
    } else {
      const close = xml.indexOf('</testcase>', openEnd);
      body = close === -1 ? xml.slice(openEnd) : xml.slice(openEnd, close);
      cursor = close === -1 ? xml.length : close + '</testcase>'.length;
    }

    tests++;
    const failureAt = body.indexOf('<failure');
    if (failureAt !== -1) {
      failed++;
      const failureEnd = endOfOpenTag(body, failureAt);
      const failureAttributes =
        failureEnd === -1 ? {} : readAttributes(body.slice(failureAt, failureEnd));
      // `file` is Bun's; the classic dialect puts the file in `classname`.
      const originatedIn = attributes.file ?? attributes.classname ?? null;
      if (originatedIn) failedFiles.add(originatedIn);
      const message = failureAttributes.message ?? failureAttributes.type ?? 'test failed';
      const headline = clip(`${attributes.name ?? 'test'}: ${message}`.trim());
      const origin = originatedIn ? clip(originatedIn) : null;
      const key = `${headline}\0${origin ?? ''}`;
      if (headlines.length < MAX_HEADLINES && !seen.has(key)) {
        seen.add(key);
        headlines.push({ message: headline, originatedIn: origin });
      }
    } else if (body.includes('<skipped')) {
      skipped++;
    } else {
      passed++;
    }
  }

  return { tests, passed, failed, skipped, failedFiles: [...failedFiles], headlines };
};

const addCounts = (left: JunitCounts, right: JunitCounts): JunitCounts => ({
  tests: left.tests + right.tests,
  passed: left.passed + right.passed,
  failed: left.failed + right.failed,
  skipped: left.skipped + right.skipped,
  // A file cannot span two shards, but a lane's own report can name it twice;
  // the set keeps the count honest either way.
  failedFiles: [...new Set([...left.failedFiles, ...right.failedFiles])],
  headlines: [...left.headlines, ...right.headlines].slice(0, MAX_HEADLINES),
});

export interface LaneResult {
  readonly lane: TestLane;
  readonly counts: JunitCounts;
  /** Number of shard files that existed for this lane. */
  readonly reports: number;
}

/**
 * Read one lane's JUnit report out of every shard directory and sum them. A
 * shard that produced no file for the lane is skipped rather than treated as
 * zero: under `--shard` a lane whose slice was empty legitimately writes
 * nothing, and `reports` reports how many were found so a caller can tell that
 * apart from every shard failing to write.
 * // Usage: await readLaneResults(['shard-1', 'shard-2']);
 */
export const readLaneResults = async (
  shardDirs: readonly string[]
): Promise<readonly LaneResult[]> =>
  Promise.all(
    TEST_LANES.map(async (lane) => {
      let counts = EMPTY_COUNTS;
      let reports = 0;
      for (const dir of shardDirs) {
        const file = Bun.file(`${dir}/${lane.junitPath}`);
        if (!(await file.exists())) continue;
        reports++;
        counts = addCounts(counts, parseJunitXml(await file.text()));
      }
      return { lane, counts, reports };
    })
  );

/** Fold lane results into the per-workspace pass counts the QA fragment carries. */
const passCountsByWorkspace = (
  results: readonly LaneResult[]
): Readonly<Record<WorkspaceName | 'root', number>> => {
  // Derived, never hand-listed: a workspace missing from this seed would make
  // `counts[lane.workspace] += n` produce NaN and serialize the total as null.
  const counts: Record<string, number> = Object.fromEntries(
    ['root', ...ALL_WORKSPACE_NAMES].map((workspace) => [workspace, 0])
  );
  for (const { lane, counts: laneCounts } of results) {
    counts[lane.workspace] += laneCounts.passed;
  }
  return counts as Readonly<Record<WorkspaceName | 'root', number>>;
};

/**
 * Build the QA fragment's tests entry from the lane reports plus the
 * unhandled errors JUnit cannot carry.
 *
 * Failure fields stay omitted on a green run so stored baselines and the
 * rendered report are unchanged by this switch. `parseMiss` keeps its meaning:
 * nothing structured explains the outcome — a non-zero exit with no JUnit
 * failures, or a configured lane that wrote no report at all (Bun can fail to
 * write JUnit and still exit 0).
 * // Usage: buildTestSuiteStats(await readLaneResults(dirs), errors, 0, 91);
 */
export const buildTestSuiteStats = (
  results: readonly LaneResult[],
  unhandledErrors: UnhandledErrors,
  exitCode: number | null,
  durationSeconds: number | null
): TestSuiteStats => {
  const passedByWorkspace = passCountsByWorkspace(results);
  const failed = results.reduce((sum, result) => sum + result.counts.failed, 0);
  // Bun's `file` attribute is workspace-relative, so the same path in two
  // lanes is two files. Namespace before counting so they do not collapse.
  const failedFiles = new Set(
    results.flatMap((result) =>
      result.counts.failedFiles.map((file) => `${result.lane.id}:${file}`)
    )
  );
  const headlines = [
    ...results.flatMap((result) => result.counts.headlines),
    ...unhandledErrors.headlines,
  ].slice(0, MAX_HEADLINES);

  const stats: TestSuiteStats = {
    exitCode,
    durationSeconds,
    passed: Object.values(passedByWorkspace).reduce((sum, count) => sum + count, 0),
    ...passedByWorkspace,
  };

  const hasFailureSignal =
    failed > 0 || failedFiles.size > 0 || unhandledErrors.errors > 0 || headlines.length > 0;
  // A lane with `reports === 0` is not an empty shard slice: every configured
  // lane is expected to write at least one file across the shard set. Bun can
  // print `JUnitReportFailed` and still exit 0, which would otherwise tally as
  // a green suite of zero tests.
  const missingLaneReports = results.some((result) => result.reports === 0);

  if (hasFailureSignal) {
    return {
      ...stats,
      failed,
      failedFiles: failedFiles.size,
      errors: unhandledErrors.errors,
      ...(headlines.length > 0 ? { headlines } : {}),
      ...(missingLaneReports ? { parseMiss: true } : {}),
    };
  }

  if (missingLaneReports || (exitCode !== 0 && exitCode !== null)) {
    return { ...stats, parseMiss: true };
  }

  return stats;
};
