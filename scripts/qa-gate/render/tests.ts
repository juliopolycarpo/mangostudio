// Test results comparison: the suite-level outcome, then one row per lane and
// per component plus the repository total. A lane that is partial shows a lower
// bound marked as such, and one that is unavailable shows n/a — neither is ever
// rendered as zero or as a complete total.

import type { LaneResult, Measurement, Metrics, TestSuiteStats } from '../collect/types';
import { presentValue } from '../model/states';
import {
  componentLabel,
  getTestSuiteEvidence,
  type LaneRow,
  type LaneTally,
  laneRows,
  tallyLanes,
} from './access';
import { formatNumber, inlineCode, NA, renderDelta } from './format';

const formatDuration = (suite: TestSuiteStats): string =>
  suite.durationSeconds == null ? 'duration n/a' : `${formatNumber(suite.durationSeconds)}s`;

const formatSuiteBreakdown = (
  suite: TestSuiteStats | null,
  state: Measurement<unknown>['state'] | undefined
): string => {
  if (!suite) return NA;
  const status = suite.exitCode == null ? 'status n/a' : `exit ${suite.exitCode}`;
  // A partial suite with nothing counted is "no lane delivered", not "zero tests".
  if (state === 'partial' && suite.passed === 0) {
    return `${NA} (partial: no lane results) · ${status} · ${formatDuration(suite)}`;
  }
  const parts = [
    `root ${formatNumber(suite.root)}`,
    `frontend ${formatNumber(suite.frontend)}`,
    `api ${formatNumber(suite.api)}`,
    `shared ${formatNumber(suite.shared)}`,
  ];
  const extras: string[] = [];
  if (state === 'partial') extras.push('partial: some lane results are missing');
  if (suite.parseMiss) extras.push('failure counts not parsed');
  if (suite.failed) extras.push(`${formatNumber(suite.failed)} failed`);
  if (suite.failedFiles) extras.push(`${formatNumber(suite.failedFiles)} failed files`);
  if (suite.errors) extras.push(`${formatNumber(suite.errors)} unhandled errors`);
  const extra = extras.length > 0 ? ` · ${extras.join(' · ')}` : '';
  const lowerBound = state === 'partial' ? '≥ ' : '';
  return `${lowerBound}${formatNumber(suite.passed)} passed (${parts.join(' / ')}) · ${status} · ${formatDuration(suite)}${extra}`;
};

const outcomeBits = (
  counts: Pick<LaneTally, 'failed' | 'skipped' | 'todo' | 'recovered'>
): string[] => {
  const bits: string[] = [];
  if (counts.failed > 0) bits.push(`${formatNumber(counts.failed)} failed`);
  if (counts.skipped > 0) bits.push(`${formatNumber(counts.skipped)} skipped`);
  if (counts.todo > 0) bits.push(`${formatNumber(counts.todo)} todo`);
  if (counts.recovered > 0) bits.push(`${formatNumber(counts.recovered)} recovered after failing`);
  return bits;
};

const processBits = (lane: LaneResult): string[] => {
  const bits: string[] = [];
  if (lane.timedOut > 0) bits.push(`timed out in ${formatNumber(lane.timedOut)} shard(s)`);
  const otherExits = lane.nonZeroExits - lane.timedOut;
  if (otherExits > 0) bits.push(`exit ≠ 0 in ${formatNumber(otherExits)} shard(s)`);
  if (lane.retriedJobs > 0) {
    bits.push(`note: ${formatNumber(lane.retriedJobs)} shard(s) ran twice (hang retried)`);
  }
  return bits;
};

const joinBits = (head: string, bits: readonly string[]): string =>
  bits.length > 0 ? `${head} · ${bits.join(' · ')}` : head;

/** One lane's cell: counts when measured, a lower bound when partial, the state otherwise. */
const renderLaneCell = (cell: Measurement<LaneResult> | null | undefined): string => {
  if (cell === undefined) return NA;
  if (cell === null) return `${NA} (not recorded)`;
  const lane = presentValue(cell);
  if (!lane) return `${NA} (${cell.state})`;
  const bits = [...outcomeBits(lane), ...processBits(lane)];
  if (cell.state === 'measured') return joinBits(`${formatNumber(lane.passed)} passed`, bits);
  const shards = `${formatNumber(lane.shards.complete)}/${formatNumber(lane.shards.expected)} shards complete`;
  return joinBits(`≥ ${formatNumber(lane.passed)} passed (partial: ${shards})`, bits);
};

/** A total: exact only when every lane under it was measured. */
const renderTallyCell = (tally: LaneTally | null): string => {
  if (!tally) return NA;
  if (tally.withValue === 0) return `${NA} (no results)`;
  const bits = outcomeBits(tally);
  if (tally.complete) return joinBits(`${formatNumber(tally.passed)} passed`, bits);
  return joinBits(`≥ ${formatNumber(tally.passed)} passed (incomplete)`, bits);
};

const deltaOf = (
  baseCell: Measurement<LaneResult> | null | undefined,
  headCell: Measurement<LaneResult> | null | undefined
): string =>
  renderDelta(
    baseCell?.state === 'measured' ? baseCell.value.passed : null,
    headCell?.state === 'measured' ? headCell.value.passed : null,
    { higherIsBetter: true, precision: 0 }
  );

const cellOf = (
  metrics: Metrics | null,
  row: LaneRow
): Measurement<LaneResult> | null | undefined => {
  if (!metrics) return undefined;
  const component = metrics.components.find((candidate) => candidate.id === row.component.id);
  if (!component) return undefined;
  return component.lanes?.find((lane) => lane.id === row.laneId)?.tests ?? null;
};

const rowsFor = (base: Metrics | null, head: Metrics | null): LaneRow[] => {
  const rows = laneRows(head);
  for (const row of laneRows(base)) {
    const known = rows.some(
      (candidate) => candidate.component.id === row.component.id && candidate.laneId === row.laneId
    );
    if (!known) rows.push(row);
  }
  return rows;
};

const tallyOf = (metrics: Metrics | null, rows: readonly LaneRow[]): LaneTally | null =>
  metrics ? tallyLanes(rows.map((row) => cellOf(metrics, row) ?? null)) : null;

const tallyDelta = (base: LaneTally | null, head: LaneTally | null): string =>
  renderDelta(base?.complete ? base.passed : null, head?.complete ? head.passed : null, {
    higherIsBetter: true,
    precision: 0,
  });

const laneRowLine = (base: Metrics | null, head: Metrics | null, row: LaneRow): string => {
  const baseCell = cellOf(base, row);
  const headCell = cellOf(head, row);
  return `| ${componentLabel(row.component)} | ${inlineCode(row.laneId)} | ${renderLaneCell(baseCell)} | ${renderLaneCell(headCell)} | ${deltaOf(baseCell, headCell)} |`;
};

const totalRowLine = (
  base: Metrics | null,
  head: Metrics | null,
  label: string,
  rows: readonly LaneRow[]
): string => {
  const baseTally = tallyOf(base, rows);
  const headTally = tallyOf(head, rows);
  return `| ${label} | **total** | ${renderTallyCell(baseTally)} | ${renderTallyCell(headTally)} | ${tallyDelta(baseTally, headTally)} |`;
};

/** Rows grouped by component, in document order. */
const groupByComponent = (rows: readonly LaneRow[]): LaneRow[][] => {
  const groups = new Map<string, LaneRow[]>();
  for (const row of rows)
    groups.set(row.component.id, [...(groups.get(row.component.id) ?? []), row]);
  return [...groups.values()];
};

const renderLaneTable = (base: Metrics | null, head: Metrics | null): string[] => {
  const rows = rowsFor(base, head);
  if (rows.length === 0) return [];
  const body = groupByComponent(rows).flatMap((group) => [
    ...group.map((row) => laneRowLine(base, head, row)),
    totalRowLine(base, head, componentLabel(group[0].component), group),
  ]);
  return [
    '#### Test lanes',
    '',
    '_One row per lane, deduplicated by test. `≥` marks a lower bound: a shard report or process receipt was missing, cut off or timed out. A partial or unavailable lane is never counted as zero, and a total over one is never complete._',
    '',
    '| Component | Lane | Base | Head | Δ passed |',
    '|---|---|---|---|---|',
    ...body,
    totalRowLine(base, head, '**repository**', rows),
    '',
  ];
};

const recoveredLines = (head: Metrics | null): string[] =>
  laneRows(head).flatMap((row) => {
    const lane = presentValue(row.cell);
    return (lane?.recoveredFailures ?? []).map(
      (headline) =>
        `- ${inlineCode(row.laneId)} failed before passing: ${inlineCode(headline.message)}`
    );
  });

const renderRecovered = (head: Metrics | null): string[] => {
  const lines = recoveredLines(head);
  return lines.length > 0 ? ['Earlier failures that passed on a later run:', '', ...lines, ''] : [];
};

export const renderTestsSection = (base: Metrics | null, head: Metrics | null): string => {
  const baseSuite = getTestSuiteEvidence(base);
  const headSuite = getTestSuiteEvidence(head);
  const complete = (metrics: Metrics | null): number | null =>
    metrics?.tests.state === 'measured' ? metrics.tests.value.passed : null;
  return [
    '### Tests',
    '',
    'Single full-suite pass (unit + integration, from the coverage run).',
    '',
    '| Base | Head | Δ passed |',
    '|---|---|---|',
    `| ${formatSuiteBreakdown(baseSuite, base?.tests.state)} | ${formatSuiteBreakdown(headSuite, head?.tests.state)} | ${renderDelta(complete(base), complete(head), { higherIsBetter: true, precision: 0 })} |`,
    '',
    ...renderLaneTable(base, head),
    ...renderRecovered(head),
  ].join('\n');
};
