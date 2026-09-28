// Assembles the sticky QA metrics PR comment from the section renderers, including
// the non-fatal collector-error and out-of-scope detail blocks and the marker.

import type { Metrics } from '../collect/types';
import { describeState, needsAttention } from '../model/states';
import { componentMeasurements, globalMeasurements } from './access';
import { renderBundleSection } from './bundle';
import { renderCoverageSection } from './coverage';
import { renderDependenciesSection } from './dependencies';
import { renderDuplicationSection } from './duplication';
import { inlineCode, shortSha } from './format';
import { renderLocSection } from './loc';
import { renderSummary } from './summary';
import { renderTestFailureLead } from './test-failures';
import { renderTestsSection } from './tests';
import { renderToolingSection } from './tooling';
import { renderVerdict } from './verdict';

/**
 * Marker closing the QA metrics comment. Distinct from the retired combined
 * report's `<!-- qa-gate-comment -->` so that comment is recognized as legacy
 * and removed only once both replacement comments are written.
 */
export const QA_METRICS_MARKER = '<!-- qa-gate-metrics-comment -->';

const collectErrorNotes = (base: Metrics | null, head: Metrics | null): string[] => {
  const notes: string[] = [];
  for (const [side, metrics] of [
    ['base', base],
    ['head', head],
  ] as const) {
    if (!metrics) {
      notes.push(`- **${side}** metrics file was not loadable.`);
      continue;
    }
    for (const [name, cell] of [
      ...componentMeasurements(metrics),
      ...globalMeasurements(metrics),
    ]) {
      if (needsAttention(cell)) notes.push(`- ${side}/${name}: ${inlineCode(describeState(cell))}`);
    }
  }
  return notes;
};

/** Render the complete QA-gate comment markdown (no trailing newline). */
export const renderDocument = (base: Metrics | null, head: Metrics | null): string => {
  const generated = head?.generatedAt ?? base?.generatedAt ?? new Date().toISOString();
  const errorNotes = collectErrorNotes(base, head);
  const failureLead = renderTestFailureLead(head?.tests).trimEnd();

  // Verdict and summary stay visible; the full tables collapse behind a
  // single details block to keep the PR discussion scannable. A failed suite
  // leads with parsed error headlines before those tables.
  const lines: string[] = [
    '## QA Gate — Coverage & Quality',
    '',
    `**Base:** \`${shortSha(base?.sha)}\` • **Head:** \`${shortSha(head?.sha)}\` • _generated ${inlineCode(generated)}_`,
    '',
    renderVerdict(base, head),
    '',
    ...(failureLead ? [failureLead, ''] : []),
    renderSummary(base, head),
    '',
    '<details>',
    '<summary>Metric details (coverage, LoC, bundle, dependencies, tests, duplication, tooling)</summary>',
    '',
    renderCoverageSection(base, head),
    renderLocSection(base, head),
    renderBundleSection(base, head),
    renderDependenciesSection(base, head),
    renderTestsSection(base, head),
    renderDuplicationSection(base, head),
    renderToolingSection(base, head),
    '</details>',
    '',
  ];

  if (errorNotes.length > 0) {
    lines.push(
      '<details>',
      '<summary>Collector errors (non-fatal)</summary>',
      '',
      ...errorNotes,
      '',
      '</details>',
      ''
    );
  }

  lines.push(QA_METRICS_MARKER);

  return lines.join('\n');
};
