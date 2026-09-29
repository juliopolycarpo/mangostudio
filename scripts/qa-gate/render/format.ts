// Pure formatting helpers and Failable guards shared by every render section.

export const NA = 'n/a';

export const shortSha = (sha: string | undefined): string => (sha ? sha.slice(0, 7) : NA);

/**
 * Embed an untrusted metric string (collector error message, task name) as an
 * inline code span it cannot escape from: backticks are replaced and newlines
 * collapsed, so artifact-supplied text never becomes active Markdown/HTML.
 */
export const inlineCode = (text: string): string =>
  `\`${text.replace(/`/g, "'").replace(/\s+/g, ' ').trim() || NA}\``;

/**
 * Escape `&`, `<` and `>` so untrusted text (commit subjects, changelog
 * entries) renders as literal text in a comment: it can never open an HTML
 * comment, tag, or entity, so it cannot hide content or forge a managed-comment
 * marker. Do not use inside a fenced code block, where it would show literally.
 * // Usage: escapeHtml('fix <!-- x --> & y') -> 'fix &lt;!-- x --&gt; &amp; y'
 */
export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Backslash-escape backticks in untrusted plain text so they can never open a
 * code span. Without this, a subject like "add `<T>`" renders its escaped
 * entities literally (`&lt;T&gt;`) inside a code span, and an unmatched
 * backtick swallows the text after it. Backslashes are escaped first so one
 * already in the text cannot cancel the escape of the backtick after it. Do not
 * use inside a code span or fenced block, where it would show literally.
 * // Usage: escapeBackticks('use `a`') -> 'use \\`a\\`'
 */
export const escapeBackticks = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

export const formatNumber = (value: number): string => value.toLocaleString('en-US');

export const formatPct = (value: number): string => `${value.toFixed(2)}%`;

export const formatBytes = (value: number): string => {
  if (value < 1024) return `${formatNumber(value)} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
};

/**
 * Percentage-point drift below this is noise, not a change worth colouring:
 * the verdict ignores it, and so do the per-crate coverage rows.
 */
export const PERCENT_EPSILON_PP = 0.1;

export interface DeltaOptions {
  readonly higherIsBetter: boolean;
  readonly suffix?: string;
  readonly precision?: number;
  /** Render the change neutral (⚪) instead of good or bad; the direction and size still show. */
  readonly neutral?: boolean;
}

/** Render a base→head numeric delta with a good/bad tag and direction arrow. */
export const renderDelta = (
  baseValue: number | null | undefined,
  headValue: number | null | undefined,
  opts: DeltaOptions
): string => {
  if (baseValue == null || headValue == null) return NA;
  const diff = headValue - baseValue;
  if (Math.abs(diff) < 1e-9) return '⚪ ▲ = 0';
  const precision = opts.precision ?? 2;
  const sign = diff > 0 ? '+' : '';
  const magnitude = `${sign}${diff.toFixed(precision).replace(/\.00$/, '')}${opts.suffix ?? ''}`;
  const isGood = opts.higherIsBetter ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const tag = opts.neutral ? '⚪' : isGood ? '🟢' : '🔴';
  return `${tag} ${arrow} ${magnitude}`;
};

/** Like renderDelta but formats the magnitude as bytes (smaller is better). */
export const renderByteDelta = (
  baseValue: number | null | undefined,
  headValue: number | null | undefined
): string => {
  if (baseValue == null || headValue == null) return NA;
  const diff = headValue - baseValue;
  if (diff === 0) return '⚪ ▲ = 0';
  const sign = diff > 0 ? '+' : '-';
  const isGood = diff < 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const tag = isGood ? '🟢' : '🔴';
  return `${tag} ${arrow} ${sign}${formatBytes(Math.abs(diff))}`;
};
