// Lines-of-code comparison table (per discovered component + total). The
// headline counts authored source (production + test); a component whose
// count is partial, stale or unavailable shows its state instead of a number,
// and no delta is computed against it.

import type { LocBucket, Metrics } from '../collect/types';
import { componentLabel, componentRows, findComponent, getLoc, TOTAL } from './access';
import { formatNumber, NA, renderDelta } from './format';

const formatLoc = (loc: LocBucket): string =>
  `${formatNumber(loc.files)} files / ${formatNumber(loc.code)} lines`;

const renderLocCell = (metrics: Metrics | null, id: string): string => {
  if (!metrics) return NA;
  const loc = getLoc(metrics, id);
  if (loc) return formatLoc(loc);
  if (id === TOTAL) return `${NA} (incomplete)`;
  const component = findComponent(metrics, id);
  return component ? `${NA} (${component.loc.state})` : NA;
};

const renderLocRow = (
  base: Metrics | null,
  head: Metrics | null,
  id: string,
  label: string
): string => {
  const baseLoc = getLoc(base, id);
  const headLoc = getLoc(head, id);
  const codeDelta = renderDelta(baseLoc?.code, headLoc?.code, {
    higherIsBetter: false,
    precision: 0,
  });
  const fileDelta = renderDelta(baseLoc?.files, headLoc?.files, {
    higherIsBetter: false,
    precision: 0,
  });
  return `| ${label} | ${renderLocCell(base, id)} | ${renderLocCell(head, id)} | files ${fileDelta} • code ${codeDelta} |`;
};

export const renderLocSection = (base: Metrics | null, head: Metrics | null): string =>
  [
    '### Lines of Code',
    '',
    '_Authored source: production and test files of every discovered component. Generated, fixture, config and docs lines are recorded in the envelope but not counted here._',
    '',
    '| Component | Base | Head | Δ |',
    '|---|---|---|---|',
    ...componentRows(base, head).map((component) =>
      renderLocRow(base, head, component.id, componentLabel(component))
    ),
    renderLocRow(base, head, TOTAL, '**total**'),
    '',
  ].join('\n');
