// Assembles the full sticky PR comment from the section renderers, including
// the non-fatal collector-error and out-of-scope detail blocks and the marker.

import { ALL_WORKSPACE_NAMES } from '../../lib/config';
import type { Metrics } from '../collect/types';
import { renderBundleSection } from './bundle';
import { renderCoverageSection } from './coverage';
import { renderDependenciesSection } from './dependencies';
import { renderDuplicationSection } from './duplication';
import { inlineCode, isError, shortSha } from './format';
import { renderLocSection } from './loc';
import { renderSummary } from './summary';
import { renderTestFailureLead } from './test-failures';
import { renderTestsSection } from './tests';
import { renderToolingSection } from './tooling';
import { renderVerdict } from './verdict';

export const COMMENT_MARKER = '<!-- qa-gate-comment -->';

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
    for (const workspace of ALL_WORKSPACE_NAMES) {
      const cov = metrics.coverage?.[workspace];
      if (isError(cov)) notes.push(`- ${side}/coverage/${workspace}: ${inlineCode(cov.error)}`);
      const ts = metrics.tsErrors?.[workspace];
      if (isError(ts)) notes.push(`- ${side}/tsErrors/${workspace}: ${inlineCode(ts.error)}`);
      const loc = metrics.loc?.[workspace];
      if (isError(loc)) notes.push(`- ${side}/loc/${workspace}: ${inlineCode(loc.error)}`);
    }
    if (isError(metrics.tooling))
      notes.push(`- ${side}/tooling: ${inlineCode(metrics.tooling.error)}`);
    if (isError(metrics.duplication))
      notes.push(`- ${side}/duplication: ${inlineCode(metrics.duplication.error)}`);
    if (isError(metrics.circularDeps))
      notes.push(`- ${side}/circularDeps: ${inlineCode(metrics.circularDeps.error)}`);
    if (isError(metrics.frontendBundle))
      notes.push(`- ${side}/frontendBundle: ${inlineCode(metrics.frontendBundle.error)}`);
    if (isError(metrics.dependencies))
      notes.push(`- ${side}/dependencies: ${inlineCode(metrics.dependencies.error)}`);
    if (isError(metrics.tests)) notes.push(`- ${side}/tests: ${inlineCode(metrics.tests.error)}`);
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

  lines.push(COMMENT_MARKER);

  return lines.join('\n');
};
