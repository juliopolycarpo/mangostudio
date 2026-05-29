// Dependency footprint comparison table (locked packages, direct deps, manifests).

import type { DependencyStats, Metrics } from '../collect/types';
import { getDependencies } from './access';
import { formatNumber, NA, renderDelta } from './format';

const renderDependencyRow = (
  base: Metrics | null,
  head: Metrics | null,
  label: string,
  selector: (dependencies: DependencyStats) => number
): string => {
  const baseDeps = getDependencies(base);
  const headDeps = getDependencies(head);
  const baseValue = baseDeps ? selector(baseDeps) : null;
  const headValue = headDeps ? selector(headDeps) : null;
  return `| ${label} | ${baseValue == null ? NA : formatNumber(baseValue)} | ${headValue == null ? NA : formatNumber(headValue)} | ${renderDelta(baseValue, headValue, { higherIsBetter: false, precision: 0 })} |`;
};

export const renderDependenciesSection = (base: Metrics | null, head: Metrics | null): string =>
  [
    '### Dependencies',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    renderDependencyRow(base, head, 'locked packages', (deps) => deps.lockedPackages),
    renderDependencyRow(base, head, 'direct dependencies', (deps) => deps.directDependencies),
    renderDependencyRow(base, head, 'direct devDependencies', (deps) => deps.directDevDependencies),
    renderDependencyRow(base, head, 'workspace manifests', (deps) => deps.workspaceManifests),
    '',
  ].join('\n');
