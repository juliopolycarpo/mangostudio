// Count test outcomes from the JUnit XML each lane writes, and turn the folded
// per-lane results (./results/) into the suite-level tally the fragment carries.
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
import type { TestLane } from '../lib/test-lanes';
import type { LaneResult, TestErrorHeadline, TestSuiteStats } from './collect/types';
import { type Measurement, presentValue } from './model/states';
import type { UnhandledErrors } from './unhandled-errors';

const MAX_HEADLINES = 5;
const MAX_HEADLINE_CHARS = 400;

type CaseOutcome = 'passed' | 'failed' | 'skipped' | 'todo';

/** One `<testcase>` with the identity that lets a repeated run of it be recognised. */
export interface JunitCase {
  /** `file|classname|name|line`: stable across reruns, distinct for same-titled tests on different lines. */
  readonly identity: string;
  readonly outcome: CaseOutcome;
  /** The owning file, when the report names one. */
  readonly file: string | null;
  /** Present exactly for a failed case. */
  readonly headline: TestErrorHeadline | null;
}

export interface JunitCounts {
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  /** Skipped cases, excluding `todo`. */
  readonly skipped: number;
  /** Bun reports a todo as `<skipped message="TODO"/>`. */
  readonly todo: number;
  /** Distinct files owning at least one failing case. */
  readonly failedFiles: readonly string[];
  readonly headlines: readonly TestErrorHeadline[];
  /** Every case in document order; nothing is deduplicated within one report. */
  readonly cases: readonly JunitCase[];
  /**
   * Why the document cannot be the whole report, or null when it is complete:
   * no closing `</testsuites>`, a cut-off element, or a `tests` header that
   * disagrees with the cases found. Counts from a truncated report are a lower bound.
   */
  readonly truncated: string | null;
}

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

const TESTCASE_CLOSE = '</testcase>';
const TESTSUITES_CLOSE = '</testsuites>';

/** The root element's declared `tests` count, or null when the header does not carry one. */
const declaredTests = (xml: string): number | null => {
  const open = xml.indexOf('<testsuites');
  if (open === -1) return null;
  const end = endOfOpenTag(xml, open);
  if (end === -1) return null;
  const declared = Number(readAttributes(xml.slice(open, end)).tests);
  return Number.isInteger(declared) && declared >= 0 ? declared : null;
};

/**
 * Whether the document is demonstrably the whole report. `endedInsideElement`
 * is set by the scan when a `<testcase>` open tag or body ran off the end.
 */
const truncationReason = (
  xml: string,
  cases: number,
  endedInsideElement: boolean
): string | null => {
  if (endedInsideElement) return 'a testcase element was cut off';
  if (!xml.includes(TESTSUITES_CLOSE)) return `no closing ${TESTSUITES_CLOSE}`;
  const declared = declaredTests(xml);
  if (declared !== null && declared !== cases) {
    return `header declares ${declared} tests but ${cases} testcases were found`;
  }
  return null;
};

const caseIdentity = (attributes: Readonly<Record<string, string>>): string =>
  [
    attributes.file ?? '',
    attributes.classname ?? '',
    attributes.name ?? '',
    attributes.line ?? '',
  ].join('|');

const TODO_MARKER_RE = /<skipped[^>]*message="TODO"/;

const outcomeOf = (body: string): CaseOutcome => {
  if (body.includes('<failure')) return 'failed';
  if (!body.includes('<skipped')) return 'passed';
  return TODO_MARKER_RE.test(body) ? 'todo' : 'skipped';
};

const failureHeadline = (
  attributes: Readonly<Record<string, string>>,
  body: string,
  originatedIn: string | null
): TestErrorHeadline => {
  const failureAt = body.indexOf('<failure');
  const failureEnd = endOfOpenTag(body, failureAt);
  const failureAttributes =
    failureEnd === -1 ? {} : readAttributes(body.slice(failureAt, failureEnd));
  const message = failureAttributes.message ?? failureAttributes.type ?? 'test failed';
  return {
    message: clip(`${attributes.name ?? 'test'}: ${message}`.trim()),
    originatedIn: originatedIn ? clip(originatedIn) : null,
  };
};

/**
 * Count outcomes and collect failure headlines from one JUnit document. A
 * document that is not demonstrably whole says so in `truncated`; its counts
 * are then a lower bound, never a complete total.
 * // Usage: parseJunitXml(await Bun.file('.mango/artifacts/junit/api.xml').text());
 */
export const parseJunitXml = (xml: string): JunitCounts => {
  const cases: JunitCase[] = [];
  const failedFiles = new Set<string>();
  const headlines: TestErrorHeadline[] = [];
  const seen = new Set<string>();
  let endedInsideElement = false;

  let cursor = 0;
  while (true) {
    const open = xml.indexOf('<testcase', cursor);
    if (open === -1) break;

    const openEnd = endOfOpenTag(xml, open);
    if (openEnd === -1) {
      endedInsideElement = true;
      break;
    }

    const openTag = xml.slice(open, openEnd);
    const attributes = readAttributes(openTag);
    let body = '';
    if (openTag.endsWith('/>')) {
      cursor = openEnd;
    } else {
      const close = xml.indexOf(TESTCASE_CLOSE, openEnd);
      endedInsideElement ||= close === -1;
      body = close === -1 ? xml.slice(openEnd) : xml.slice(openEnd, close);
      cursor = close === -1 ? xml.length : close + TESTCASE_CLOSE.length;
    }

    const outcome = outcomeOf(body);
    // `file` is Bun's; the classic dialect puts the file in `classname`.
    const originatedIn = attributes.file ?? attributes.classname ?? null;
    const headline = outcome === 'failed' ? failureHeadline(attributes, body, originatedIn) : null;
    cases.push({ identity: caseIdentity(attributes), outcome, file: originatedIn, headline });
    if (!headline) continue;

    if (originatedIn) failedFiles.add(originatedIn);
    const key = `${headline.message}\0${headline.originatedIn ?? ''}`;
    if (headlines.length < MAX_HEADLINES && !seen.has(key)) {
      seen.add(key);
      headlines.push(headline);
    }
  }

  const tally = (outcome: CaseOutcome): number =>
    cases.filter((testCase) => testCase.outcome === outcome).length;

  return {
    tests: cases.length,
    passed: tally('passed'),
    failed: tally('failed'),
    skipped: tally('skipped'),
    todo: tally('todo'),
    failedFiles: [...failedFiles],
    headlines,
    cases,
    truncated: truncationReason(xml, cases.length, endedInsideElement),
  };
};

/** One lane's fold: its registry entry and the measurement of its results. */
export interface LaneOutcome {
  readonly lane: TestLane;
  readonly result: Measurement<LaneResult>;
}

const NO_RESULT: LaneResult = {
  passed: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
  recovered: 0,
  failedFiles: 0,
  shards: { expected: 0, complete: 0 },
  nonZeroExits: 0,
  timedOut: 0,
  retriedJobs: 0,
  headlines: [],
  recoveredFailures: [],
};

/** Sum one counter over every lane that has a value; an unavailable lane adds nothing. */
const sumPresent = (outcomes: readonly LaneOutcome[], pick: (lane: LaneResult) => number): number =>
  outcomes.reduce((sum, { result }) => sum + pick(presentValue(result) ?? NO_RESULT), 0);

/** Fold lane results into the per-workspace pass counts the QA fragment carries. */
const passCountsByWorkspace = (
  outcomes: readonly LaneOutcome[]
): Readonly<Record<WorkspaceName | 'root', number>> => {
  // Derived, never hand-listed: a workspace missing from this seed would make
  // `counts[lane.workspace] += n` produce NaN and serialize the total as null.
  const counts: Record<string, number> = Object.fromEntries(
    ['root', ...ALL_WORKSPACE_NAMES].map((workspace) => [workspace, 0])
  );
  for (const { lane, result } of outcomes) {
    counts[lane.workspace] += presentValue(result)?.passed ?? 0;
  }
  return counts as Readonly<Record<WorkspaceName | 'root', number>>;
};

/**
 * Build the QA fragment's tests entry from the folded lanes plus the unhandled
 * errors JUnit cannot carry. The counters are lower bounds whenever a lane is
 * not `measured`; the caller states that with a `partial` measurement.
 *
 * Failure fields stay omitted on a green run so stored baselines and the
 * rendered report are unchanged by this switch. `parseMiss` keeps its meaning:
 * nothing structured explains the outcome — a non-zero exit with no JUnit
 * failures, or a configured lane that delivered no results at all (Bun can
 * fail to write JUnit and still exit 0).
 * // Usage: buildTestSuiteStats(outcomes, errors, 0, 91);
 */
export const buildTestSuiteStats = (
  outcomes: readonly LaneOutcome[],
  unhandledErrors: UnhandledErrors,
  exitCode: number | null,
  durationSeconds: number | null
): TestSuiteStats => {
  const passedByWorkspace = passCountsByWorkspace(outcomes);
  const failed = sumPresent(outcomes, (lane) => lane.failed);
  // Bun's `file` attribute is workspace-relative, so the same path in two
  // lanes is two files; each lane already counts its own distinct files.
  const failedFiles = sumPresent(outcomes, (lane) => lane.failedFiles);
  const headlines = [
    ...outcomes.flatMap(({ result }) => presentValue(result)?.headlines ?? []),
    ...unhandledErrors.headlines,
  ].slice(0, MAX_HEADLINES);

  const stats: TestSuiteStats = {
    exitCode,
    durationSeconds,
    passed: Object.values(passedByWorkspace).reduce((sum, count) => sum + count, 0),
    ...passedByWorkspace,
  };

  const hasFailureSignal =
    failed > 0 || failedFiles > 0 || unhandledErrors.errors > 0 || headlines.length > 0;
  // A lane with no readable result is not an empty shard slice: every
  // configured lane is expected to deliver at least one report across the
  // shard set. Bun can print `JUnitReportFailed` and still exit 0, which would
  // otherwise tally as a green suite of zero tests.
  const unreadableLane = outcomes.some(({ result }) => presentValue(result) === null);

  if (hasFailureSignal) {
    return {
      ...stats,
      failed,
      failedFiles,
      errors: unhandledErrors.errors,
      ...(headlines.length > 0 ? { headlines } : {}),
      ...(unreadableLane ? { parseMiss: true } : {}),
    };
  }

  if (unreadableLane || (exitCode !== 0 && exitCode !== null)) {
    return { ...stats, parseMiss: true };
  }

  return stats;
};
