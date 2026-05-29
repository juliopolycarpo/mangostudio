// One-line headline of the most important base→head deltas.

import type { Metrics } from '../collect/types';
import {
  getBundle,
  getCoverageBucket,
  getDependencies,
  getDuplication,
  getLoc,
  getTestLane,
  getTooling,
  renderToolingStatus,
} from './access';
import { renderByteDelta, renderDelta } from './format';

export const renderSummary = (base: Metrics | null, head: Metrics | null): string => {
  const baseLoc = getLoc(base, 'total');
  const headLoc = getLoc(head, 'total');
  const baseFrontLines = getCoverageBucket(base?.coverage?.frontend, 'lines')?.pct ?? null;
  const headFrontLines = getCoverageBucket(head?.coverage?.frontend, 'lines')?.pct ?? null;
  const baseDup = getDuplication(base);
  const headDup = getDuplication(head);
  const baseBundle = getBundle(base);
  const headBundle = getBundle(head);
  const baseDeps = getDependencies(base);
  const headDeps = getDependencies(head);
  const baseUnit = getTestLane(base, 'unit');
  const headUnit = getTestLane(head, 'unit');

  return [
    `**LoC (code):** ${renderDelta(baseLoc?.code, headLoc?.code, { higherIsBetter: false, precision: 0 })}`,
    `**Frontend line coverage:** ${renderDelta(baseFrontLines, headFrontLines, { higherIsBetter: true, suffix: 'pp' })}`,
    `**Quick check:** ${renderToolingStatus(getTooling(head))}`,
    `**Duplication:** ${renderDelta(baseDup?.percentage ?? null, headDup?.percentage ?? null, { higherIsBetter: false, suffix: 'pp' })}`,
    `**Bundle gzip:** ${renderByteDelta(baseBundle?.gzipBytes, headBundle?.gzipBytes)}`,
    `**Locked deps:** ${renderDelta(baseDeps?.lockedPackages, headDeps?.lockedPackages, { higherIsBetter: false, precision: 0 })}`,
    `**Unit tests:** ${renderDelta(baseUnit?.passed, headUnit?.passed, { higherIsBetter: true, precision: 0 })}`,
  ].join(' • ');
};
