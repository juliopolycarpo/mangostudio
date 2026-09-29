// Headline verdict for the QA-gate comment. The decision lives in
// ../policy/verdict.ts; this file only words it: either "no attention signals",
// a short list of concrete regressions and missing evidence, or an explicit
// "unverified" when nothing regressed but the evidence is not all there.

import type { Metrics } from '../collect/types';
import { evaluateVerdict, type Verdict } from '../policy/verdict';
import { inlineCode } from './format';

const uncollectedItem = (verdict: Verdict): string[] =>
  verdict.gaps.length > 0
    ? [`metrics not collected: ${verdict.gaps.map(inlineCode).join(', ')}`]
    : [];

const attentionItems = (verdict: Verdict): string[] => [
  ...uncollectedItem(verdict),
  ...verdict.regressions,
];

/**
 * Collect the head-side items worth flagging in the headline: metrics that were
 * not collected, then the concrete regressions.
 * // Usage: collectAttentionItems(base, head)
 */
export const collectAttentionItems = (base: Metrics | null, head: Metrics | null): string[] =>
  attentionItems(evaluateVerdict(base, head));

const withNotes = (line: string, verdict: Verdict): string =>
  verdict.notes.length > 0 ? `${line} _(${verdict.notes.join('; ')})_` : line;

/**
 * Render the one-line verdict shown at the top of the QA-gate comment.
 * // Usage: renderVerdict(base, head)
 */
export const renderVerdict = (base: Metrics | null, head: Metrics | null): string => {
  if (!head) {
    return '⚠️ **Verdict unavailable** — head metrics were not collected; see collector errors below.';
  }
  const verdict = evaluateVerdict(base, head);
  const items = attentionItems(verdict);
  if (items.length > 0) {
    return withNotes(`⚠️ **Needs attention:** ${items.join(' · ')}`, verdict);
  }
  if (verdict.outcome === 'incomplete') {
    const gaps = verdict.baseGaps.map(inlineCode).join(', ');
    return withNotes(
      `⚠️ **Unverified** — the head metrics show no regressions, but the base is incomplete (${gaps}), so those comparisons were not made; see collector notes.`,
      verdict
    );
  }
  if (verdict.comparison !== 'complete') {
    return withNotes(
      '✅ **No attention signals** — head metrics look healthy, but some base↔head comparisons were unavailable; see metric details and collector notes.',
      verdict
    );
  }
  return withNotes(
    '✅ **No attention signals** — collected metrics look healthy against base.',
    verdict
  );
};
