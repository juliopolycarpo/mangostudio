// Lines-of-code comparison table (per workspace + total).

import type { WorkspaceName } from '../../lib/config';
import type { Metrics } from '../collect/types';
import { getLoc, WORKSPACE_ORDER } from './access';
import { formatNumber, NA, renderDelta } from './format';

const renderLocRow = (
  base: Metrics | null,
  head: Metrics | null,
  workspace: WorkspaceName | 'total'
): string => {
  const baseLoc = getLoc(base, workspace);
  const headLoc = getLoc(head, workspace);
  const baseCell = baseLoc
    ? `${formatNumber(baseLoc.files)} files / ${formatNumber(baseLoc.code)} lines`
    : NA;
  const headCell = headLoc
    ? `${formatNumber(headLoc.files)} files / ${formatNumber(headLoc.code)} lines`
    : NA;
  const codeDelta = renderDelta(baseLoc?.code, headLoc?.code, {
    higherIsBetter: false,
    precision: 0,
  });
  const fileDelta = renderDelta(baseLoc?.files, headLoc?.files, {
    higherIsBetter: false,
    precision: 0,
  });
  return `| ${workspace === 'total' ? '**total**' : workspace} | ${baseCell} | ${headCell} | files ${fileDelta} • code ${codeDelta} |`;
};

export const renderLocSection = (base: Metrics | null, head: Metrics | null): string =>
  [
    '### Lines of Code',
    '',
    '| Workspace | Base | Head | Δ |',
    '|---|---|---|---|',
    ...WORKSPACE_ORDER.map((workspace) => renderLocRow(base, head, workspace)),
    '',
  ].join('\n');
