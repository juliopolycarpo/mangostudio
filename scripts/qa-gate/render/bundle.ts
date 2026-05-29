// Frontend bundle comparison table (gzip totals per asset type + file count).

import type { BundleStats, Metrics } from '../collect/types';
import { getBundle } from './access';
import { formatBytes, formatNumber, NA, renderByteDelta, renderDelta } from './format';

const renderBundleRow = (
  base: Metrics | null,
  head: Metrics | null,
  label: string,
  selector: (bundle: BundleStats) => number,
  opts: { readonly bytes: boolean } = { bytes: true }
): string => {
  const baseBundle = getBundle(base);
  const headBundle = getBundle(head);
  const baseValue = baseBundle ? selector(baseBundle) : null;
  const headValue = headBundle ? selector(headBundle) : null;
  const format = opts.bytes ? formatBytes : formatNumber;
  const delta = opts.bytes
    ? renderByteDelta(baseValue, headValue)
    : renderDelta(baseValue, headValue, { higherIsBetter: false, precision: 0 });
  return `| ${label} | ${baseValue == null ? NA : format(baseValue)} | ${headValue == null ? NA : format(headValue)} | ${delta} |`;
};

export const renderBundleSection = (base: Metrics | null, head: Metrics | null): string =>
  [
    '### Frontend Bundle',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    renderBundleRow(base, head, 'gzip total', (bundle) => bundle.gzipBytes),
    renderBundleRow(base, head, 'gzip JavaScript', (bundle) => bundle.jsGzipBytes),
    renderBundleRow(base, head, 'gzip CSS', (bundle) => bundle.cssGzipBytes),
    renderBundleRow(base, head, 'gzip HTML', (bundle) => bundle.htmlGzipBytes),
    renderBundleRow(base, head, 'tracked files', (bundle) => bundle.files, { bytes: false }),
    '',
  ].join('\n');
