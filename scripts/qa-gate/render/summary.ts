// One-line headline of the most important base→head deltas.

import type { Metrics } from '../collect/types';
import {
  getBundle,
  getDependencies,
  getDuplication,
  getLoc,
  getTestSuite,
  getTooling,
  getTotalLineCoverage,
  renderToolingStatus,
} from './access';
import { renderByteDelta, renderDelta } from './format';

export const renderSummary = (base: Metrics | null, head: Metrics | null): string => {
  const baseLoc = getLoc(base, 'total');
  const headLoc = getLoc(head, 'total');
  const baseLines = getTotalLineCoverage(base)?.pct ?? null;
  const headLines = getTotalLineCoverage(head)?.pct ?? null;
  const baseDup = getDuplication(base);
  const headDup = getDuplication(head);
  const baseBundle = getBundle(base);
  const headBundle = getBundle(head);
  const baseDeps = getDependencies(base);
  const headDeps = getDependencies(head);
  const baseSuite = getTestSuite(base);
  const headSuite = getTestSuite(head);

  return [
    `**LoC (code):** ${renderDelta(baseLoc?.code, headLoc?.code, { higherIsBetter: false, precision: 0 })}`,
    `**Line coverage (all workspaces):** ${renderDelta(baseLines, headLines, { higherIsBetter: true, suffix: 'pp' })}`,
    `**Quick check:** ${renderToolingStatus(getTooling(head))}`,
    `**Duplication:** ${renderDelta(baseDup?.percentage ?? null, headDup?.percentage ?? null, { higherIsBetter: false, suffix: 'pp' })}`,
    `**Bundle gzip:** ${renderByteDelta(baseBundle?.gzipBytes, headBundle?.gzipBytes)}`,
    `**Locked deps:** ${renderDelta(baseDeps?.lockedPackages, headDeps?.lockedPackages, { higherIsBetter: false, precision: 0 })}`,
    `**Tests passed:** ${renderDelta(baseSuite?.passed, headSuite?.passed, { higherIsBetter: true, precision: 0 })}`,
  ].join(' • ');
};
