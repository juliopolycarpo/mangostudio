/**
 * Pure presentation helpers for the environments surface.
 *
 * Everything here is deliberately free of React so the rules that matter — the
 * effective binary comes first, aliases collapse into one row, a finding always
 * states its consequence — can be asserted directly.
 */

import type {
  InstallGuardReason,
  LtsStatus,
  RuntimeFinding,
  RuntimeHealth,
  RuntimeInstallation,
} from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';

/** Params that name a runtime, agent, or version manager rather than a value. */
const IDENTIFIER_PARAMS = new Set(['runtime', 'targetId', 'manager']);

/** Params carrying a zero-based PATH index the UI shows one-based. */
const PATH_INDEX_PARAMS = new Set(['effectivePathIndex', 'shadowedPathIndex']);

/** Substitutes `{key}` placeholders; unknown placeholders are left untouched. */
export function formatMessage(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}

/**
 * Resolves a runtime, agent target, or version manager id to its product name.
 * Falls back to the raw id so an id added to the contract before its translation
 * degrades to something readable instead of blank.
 */
export function displayName(t: Messages, id: string): string {
  return (t.environments.names as Record<string, string | undefined>)[id] ?? id;
}

/** PATH entries are shown one-based: `PATH #1` is the first directory searched. */
export function pathPosition(pathIndex: number): number {
  return pathIndex + 1;
}

export function ltsLabel(t: Messages, status: LtsStatus): string {
  return t.environments.lts[status];
}

export function healthLabel(t: Messages, health: RuntimeHealth): string {
  return t.environments.status[health];
}

export function guardReasonLabel(t: Messages, reason: InstallGuardReason): string {
  return t.environments.install.guardBlocked[reason];
}

/**
 * Renders one finding as a sentence that names its consequence. Identifier
 * params become product names, PATH indices become one-based, and an
 * `ltsStatus` param becomes its translated label.
 */
export function describeFinding(t: Messages, finding: RuntimeFinding): string {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(finding.params ?? {})) {
    if (IDENTIFIER_PARAMS.has(key)) {
      params[key] = displayName(t, value);
    } else if (PATH_INDEX_PARAMS.has(key)) {
      const parsed = Number(value);
      params[key] = Number.isFinite(parsed) ? String(pathPosition(parsed)) : value;
    } else if (key === 'ltsStatus') {
      params[key] = ltsLabel(t, value as LtsStatus);
    } else {
      params[key] = value;
    }
  }
  // A code added to the contract before its translation lands must degrade to
  // something readable, exactly as `displayName` does — never crash the page.
  const template = (t.environments.findings as Record<string, string | undefined>)[finding.code];
  return template ? formatMessage(template, params) : finding.code;
}

/** Severity of a finding, which drives both its colour and its sort position. */
export type FindingSeverity = 'fail' | 'warn';

const FAIL_CODES = new Set<RuntimeFinding['code']>([
  'not-found',
  'not-executable',
  'version-below-minimum',
  'cli-not-installed',
  'version-probe-failed',
]);

export function findingSeverity(finding: RuntimeFinding): FindingSeverity {
  return FAIL_CODES.has(finding.code) ? 'fail' : 'warn';
}

export interface KeyedFinding {
  readonly key: string;
  readonly finding: RuntimeFinding;
}

/**
 * Findings carry no id and the same code legitimately repeats — two shadowed
 * paths are two findings — so identity is the code plus its params, with a
 * counter only for the genuinely indistinguishable case.
 */
export function keyedFindings(findings: readonly RuntimeFinding[], prefix = ''): KeyedFinding[] {
  const seen = new Map<string, number>();
  return findings.map((finding) => {
    const base = `${prefix}${finding.code}:${JSON.stringify(finding.params ?? {})}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: occurrence === 0 ? base : `${base}#${occurrence}`, finding };
  });
}

/**
 * A group of installations that all resolve to the same binary. `canonical` is
 * the one the rest are symlinks to, and `aliasCount` is how many paths reach it
 * — a symlink chain is one row with an affordance, never several rows.
 */
export interface InstallationGroup {
  readonly canonical: RuntimeInstallation;
  readonly aliases: readonly RuntimeInstallation[];
  /** Total number of paths that reach this binary, the canonical one included. */
  readonly aliasCount: number;
  readonly effective: boolean;
}

/**
 * Collapses aliases and orders the result effective-first, then by PATH
 * position. Input order is never trusted: the API is free to reorder, and
 * "which one runs" has to stay the first thing on screen.
 */
export function groupInstallations(
  installations: readonly RuntimeInstallation[]
): InstallationGroup[] {
  const byRealPath = new Map<string, RuntimeInstallation[]>();
  for (const installation of installations) {
    const existing = byRealPath.get(installation.path);
    if (existing) existing.push(installation);
    else byRealPath.set(installation.path, [installation]);
  }

  const groups: InstallationGroup[] = [];
  for (const members of byRealPath.values()) {
    const canonical = members.find((member) => member.aliasOf === undefined) ?? members[0];
    if (!canonical) continue;
    groups.push({
      canonical,
      aliases: members.filter((member) => member !== canonical),
      aliasCount: members.length,
      effective: members.some((member) => member.effective),
    });
  }

  return groups.sort((left, right) => {
    if (left.effective !== right.effective) return left.effective ? -1 : 1;
    return pathIndexRank(left.canonical) - pathIndexRank(right.canonical);
  });
}

/** Installations outside PATH sort last; they can never be the one that runs. */
function pathIndexRank(installation: RuntimeInstallation): number {
  return installation.pathIndex ?? Number.MAX_SAFE_INTEGER;
}

/** Human-readable byte count for the installer download disclosure. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/** Elapsed install time, rounded to something a human reads at a glance. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
