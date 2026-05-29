// Code duplication comparison table (jscpd clones, lines, percentage).

import type { Metrics } from '../collect/types';
import { getDuplication } from './access';
import { formatNumber, formatPct, NA, renderDelta } from './format';

export const renderDuplicationSection = (base: Metrics | null, head: Metrics | null): string => {
  const baseDup = getDuplication(base);
  const headDup = getDuplication(head);

  const rows = [
    `| clones | ${baseDup ? formatNumber(baseDup.clones) : NA} | ${headDup ? formatNumber(headDup.clones) : NA} | ${renderDelta(baseDup?.clones, headDup?.clones, { higherIsBetter: false, precision: 0 })} |`,
    `| duplicated lines | ${baseDup ? formatNumber(baseDup.duplicatedLines) : NA} | ${headDup ? formatNumber(headDup.duplicatedLines) : NA} | ${renderDelta(baseDup?.duplicatedLines, headDup?.duplicatedLines, { higherIsBetter: false, precision: 0 })} |`,
    `| percentage | ${baseDup ? formatPct(baseDup.percentage) : NA} | ${headDup ? formatPct(headDup.percentage) : NA} | ${renderDelta(baseDup?.percentage, headDup?.percentage, { higherIsBetter: false, suffix: 'pp' })} |`,
  ];

  return [
    '### Code Duplication (jscpd)',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};
