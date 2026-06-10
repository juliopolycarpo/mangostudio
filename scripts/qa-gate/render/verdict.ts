// Headline verdict for the QA-gate comment: distills every collected metric
// into either "no attention signals" or a short list of concrete regressions,
// so reviewers don't have to scan the detail tables.

import type { Metrics } from '../collect/types';
import {
  getBundle,
  getCircularDeps,
  getDuplication,
  getTestLane,
  getTooling,
  getTotalLineCoverage,
  sumTsErrors,
} from './access';
import { formatBytes } from './format';

// Ignore sub-0.1pp percentage drift and sub-10KiB gzip growth — both are
// routine noise on unrelated changes and would make the verdict cry wolf.
const PERCENT_EPSILON_PP = 0.1;
const BUNDLE_GROWTH_THRESHOLD_BYTES = 10 * 1024;

const coverageDropItem = (base: Metrics | null, head: Metrics | null): string | null => {
  const basePct = getTotalLineCoverage(base)?.pct;
  const headPct = getTotalLineCoverage(head)?.pct;
  if (basePct == null || headPct == null) return null;
  const drop = basePct - headPct;
  if (drop < PERCENT_EPSILON_PP) return null;
  return `line coverage −${drop.toFixed(2)}pp`;
};

const duplicationItem = (base: Metrics | null, head: Metrics | null): string | null => {
  const basePct = getDuplication(base)?.percentage;
  const headPct = getDuplication(head)?.percentage;
  if (basePct == null || headPct == null) return null;
  const growth = headPct - basePct;
  if (growth < PERCENT_EPSILON_PP) return null;
  return `duplication +${growth.toFixed(2)}pp`;
};

const bundleItem = (base: Metrics | null, head: Metrics | null): string | null => {
  const baseGzip = getBundle(base)?.gzipBytes;
  const headGzip = getBundle(head)?.gzipBytes;
  if (baseGzip == null || headGzip == null) return null;
  const growth = headGzip - baseGzip;
  if (growth < BUNDLE_GROWTH_THRESHOLD_BYTES) return null;
  return `bundle gzip +${formatBytes(growth)}`;
};

const testLaneItems = (head: Metrics | null): string[] => {
  const items: string[] = [];
  for (const lane of ['unit', 'integration'] as const) {
    const stats = getTestLane(head, lane);
    if (stats && stats.exitCode !== 0 && stats.exitCode !== null) {
      items.push(`${lane} tests failing (exit ${stats.exitCode})`);
    }
  }
  return items;
};

/**
 * Collect the head-side regressions worth flagging in the headline.
 * // Usage: collectAttentionItems(base, head)
 */
export const collectAttentionItems = (base: Metrics | null, head: Metrics | null): string[] => {
  const items: string[] = [];

  items.push(...testLaneItems(head));

  const tooling = getTooling(head);
  if (tooling && tooling.checkExitCode !== 0) {
    const failed = tooling.failedTasks.length > 0 ? `: ${tooling.failedTasks.join(', ')}` : '';
    items.push(`repo check failing${failed}`);
  }

  const tsErrors = sumTsErrors(head);
  if (tsErrors != null && tsErrors > 0) {
    items.push(`${tsErrors} TypeScript error${tsErrors === 1 ? '' : 's'}`);
  }

  const circular = getCircularDeps(head);
  if (circular != null && circular > 0) {
    items.push(`${circular} circular dependenc${circular === 1 ? 'y' : 'ies'}`);
  }

  for (const item of [
    coverageDropItem(base, head),
    duplicationItem(base, head),
    bundleItem(base, head),
  ]) {
    if (item) items.push(item);
  }

  return items;
};

/**
 * Render the one-line verdict shown at the top of the QA-gate comment.
 * // Usage: renderVerdict(base, head)
 */
export const renderVerdict = (base: Metrics | null, head: Metrics | null): string => {
  if (!head) {
    return '⚠️ **Verdict unavailable** — head metrics were not collected; see collector errors below.';
  }
  const items = collectAttentionItems(base, head);
  if (items.length === 0) {
    return '✅ **No attention signals** — collected metrics look healthy against base.';
  }
  return `⚠️ **Needs attention:** ${items.join(' · ')}`;
};
