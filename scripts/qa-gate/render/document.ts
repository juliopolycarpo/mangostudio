// Assembles the full sticky PR comment from the section renderers, including
// the non-fatal collector-error and out-of-scope detail blocks and the marker.

import { ALL_WORKSPACE_NAMES } from '../../lib/config';
import type { Metrics } from '../collect/types';
import { renderBundleSection } from './bundle';
import { renderCoverageSection } from './coverage';
import { renderDependenciesSection } from './dependencies';
import { renderDuplicationSection } from './duplication';
import { isError, shortSha } from './format';
import { renderLocSection } from './loc';
import { renderSummary } from './summary';
import { renderTestsSection } from './tests';
import { renderToolingSection } from './tooling';

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
      if (isError(cov)) notes.push(`- ${side}/coverage/${workspace}: \`${cov.error}\``);
      const ts = metrics.tsErrors?.[workspace];
      if (isError(ts)) notes.push(`- ${side}/tsErrors/${workspace}: \`${ts.error}\``);
      const loc = metrics.loc?.[workspace];
      if (isError(loc)) notes.push(`- ${side}/loc/${workspace}: \`${loc.error}\``);
    }
    if (isError(metrics.tooling)) notes.push(`- ${side}/tooling: \`${metrics.tooling.error}\``);
    if (isError(metrics.duplication))
      notes.push(`- ${side}/duplication: \`${metrics.duplication.error}\``);
    if (isError(metrics.circularDeps))
      notes.push(`- ${side}/circularDeps: \`${metrics.circularDeps.error}\``);
    if (isError(metrics.frontendBundle))
      notes.push(`- ${side}/frontendBundle: \`${metrics.frontendBundle.error}\``);
    if (isError(metrics.dependencies))
      notes.push(`- ${side}/dependencies: \`${metrics.dependencies.error}\``);
    for (const lane of ['unit', 'integration'] as const) {
      const tests = metrics.tests?.[lane];
      if (isError(tests)) notes.push(`- ${side}/tests/${lane}: \`${tests.error}\``);
    }
  }
  return notes;
};

/** Render the complete QA-gate comment markdown (no trailing newline). */
export const renderDocument = (base: Metrics | null, head: Metrics | null): string => {
  const generated = head?.generatedAt ?? base?.generatedAt ?? new Date().toISOString();
  const errorNotes = collectErrorNotes(base, head);

  const lines: string[] = [
    '## QA Gate — Coverage & Quality',
    '',
    `**Base:** \`${shortSha(base?.sha)}\` • **Head:** \`${shortSha(head?.sha)}\` • _generated ${generated}_`,
    '',
    renderSummary(base, head),
    '',
    renderCoverageSection(base, head),
    renderLocSection(base, head),
    renderBundleSection(base, head),
    renderDependenciesSection(base, head),
    renderTestsSection(base, head),
    renderDuplicationSection(base, head),
    renderToolingSection(base, head),
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

  lines.push(
    '<details>',
    '<summary>Out-of-scope (potential follow-ups)</summary>',
    '',
    '- Native Bun branch and statement records when Bun LCOV emits them directly.',
    '- Per-chunk bundle deltas for the largest frontend assets.',
    '- Runtime startup and first-load smoke timings.',
    '',
    '</details>',
    '',
    COMMENT_MARKER
  );

  return lines.join('\n');
};
