// Repo tooling comparison table (full check status, total TS errors, cycles).

import type { Metrics } from '../collect/types';
import { getCircularDeps, getTooling, renderToolingStatus, sumTsErrors } from './access';
import { formatNumber, NA, renderDelta } from './format';

export const renderToolingSection = (base: Metrics | null, head: Metrics | null): string => {
  const baseTooling = getTooling(base);
  const headTooling = getTooling(head);
  const baseTs = sumTsErrors(base);
  const headTs = sumTsErrors(head);
  const baseCirc = getCircularDeps(base);
  const headCirc = getCircularDeps(head);

  const numCell = (value: number | null) => (value == null ? NA : formatNumber(value));
  const rows = [
    `| Full repo check | ${renderToolingStatus(baseTooling)} | ${renderToolingStatus(headTooling)} | ${renderDelta(baseTooling?.checkExitCode, headTooling?.checkExitCode, { higherIsBetter: false, precision: 0 })} |`,
    `| TS errors (total) | ${numCell(baseTs)} | ${numCell(headTs)} | ${renderDelta(baseTs, headTs, { higherIsBetter: false, precision: 0 })} |`,
    `| Circular dependencies | ${numCell(baseCirc)} | ${numCell(headCirc)} | ${renderDelta(baseCirc, headCirc, { higherIsBetter: false, precision: 0 })} |`,
  ];

  return [
    '### Repo Tooling',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};
