// Pure formatting helpers and Failable guards shared by every render section.

import type { Failable } from '../collect/types';

export const NA = 'n/a';

export const isError = <T>(value: Failable<T> | null | undefined): value is { error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;

export const ok = <T>(value: Failable<T> | null | undefined): value is T =>
  value !== null && value !== undefined && !isError(value);

export const shortSha = (sha: string | undefined): string => (sha ? sha.slice(0, 7) : NA);

export const formatNumber = (value: number): string => value.toLocaleString('en-US');

export const formatPct = (value: number): string => `${value.toFixed(2)}%`;

export const formatBytes = (value: number): string => {
  if (value < 1024) return `${formatNumber(value)} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
};

export interface DeltaOptions {
  readonly higherIsBetter: boolean;
  readonly suffix?: string;
  readonly precision?: number;
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
  const tag = isGood ? '🟢' : '🔴';
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
