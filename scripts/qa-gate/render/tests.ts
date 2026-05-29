// Test results comparison table (pass counts per lane, broken down by workspace).

import type { Metrics, TestLaneStats } from '../collect/types';
import { getTestLane } from './access';
import { formatNumber, NA, renderDelta } from './format';

const formatTestBreakdown = (lane: TestLaneStats | null): string => {
  if (!lane) return NA;
  const parts = [
    `root ${formatNumber(lane.root)}`,
    `frontend ${formatNumber(lane.frontend)}`,
    `api ${formatNumber(lane.api)}`,
    `shared ${formatNumber(lane.shared)}`,
  ];
  const status = lane.exitCode == null ? 'status n/a' : `exit ${lane.exitCode}`;
  return `${formatNumber(lane.passed)} passed (${parts.join(' / ')}) · ${status}`;
};

const renderTestLaneRow = (
  base: Metrics | null,
  head: Metrics | null,
  lane: 'unit' | 'integration'
): string => {
  const baseLane = getTestLane(base, lane);
  const headLane = getTestLane(head, lane);
  return `| ${lane} | ${formatTestBreakdown(baseLane)} | ${formatTestBreakdown(headLane)} | ${renderDelta(baseLane?.passed, headLane?.passed, { higherIsBetter: true, precision: 0 })} |`;
};

export const renderTestsSection = (base: Metrics | null, head: Metrics | null): string =>
  [
    '### Tests by Lane',
    '',
    '| Lane | Base | Head | Δ passed |',
    '|---|---|---|---|',
    renderTestLaneRow(base, head, 'unit'),
    renderTestLaneRow(base, head, 'integration'),
    '',
  ].join('\n');
