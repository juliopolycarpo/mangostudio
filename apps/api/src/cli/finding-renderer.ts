/**
 * English rendering for structured runtime findings. The UI uses i18n; the CLI
 * uses the same English templates from shared messages so codes cannot drift.
 */

import type {
  LtsStatus,
  RuntimeFinding,
  RuntimeFindingCode,
  RuntimeHealth,
} from '@mangostudio/shared/environments';
import {
  environmentDisplayNamesEn,
  environmentFindingTemplatesEn,
  environmentLtsLabelsEn,
} from '@mangostudio/shared/environments';
import type { CheckResult, CheckStatus } from './doctor-checks';

const LEGACY_DETAIL_CODE = 'legacy-detail' as const;

const IDENTIFIER_PARAMS = new Set(['runtime', 'targetId', 'manager']);
const PATH_INDEX_PARAMS = new Set(['effectivePathIndex', 'shadowedPathIndex']);

const FAIL_CODES = new Set<RuntimeFindingCode>([
  'not-found',
  'not-executable',
  'version-below-minimum',
  'cli-not-installed',
  'version-probe-failed',
]);

export type LegacyDetailFinding = {
  readonly code: typeof LEGACY_DETAIL_CODE;
  readonly params: { readonly detail: string };
};

export type RenderableFinding = RuntimeFinding | LegacyDetailFinding;

/** Every structured finding code that has an English template in shared i18n. */
export const RUNTIME_FINDING_CODES = Object.keys(
  environmentFindingTemplatesEn
) as RuntimeFindingCode[];

function formatMessage(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}

function displayName(id: string): string {
  return (environmentDisplayNamesEn as Record<string, string | undefined>)[id] ?? id;
}

function pathPosition(pathIndex: number): number {
  return pathIndex + 1;
}

function ltsLabel(status: LtsStatus): string {
  return environmentLtsLabelsEn[status];
}

/** True when a rendered line still contains `{placeholder}` tokens. */
export function hasUnfilledPlaceholders(line: string): boolean {
  return /\{\w+\}/.test(line);
}

/** Render one finding as a single English sentence for terminal output. */
export function renderFinding(finding: RenderableFinding): string {
  if (finding.code === LEGACY_DETAIL_CODE) {
    return finding.params.detail;
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(finding.params ?? {})) {
    if (IDENTIFIER_PARAMS.has(key)) {
      params[key] = displayName(value);
    } else if (PATH_INDEX_PARAMS.has(key)) {
      const parsed = Number(value);
      params[key] = Number.isFinite(parsed) ? String(pathPosition(parsed)) : value;
    } else if (key === 'ltsStatus') {
      params[key] = ltsLabel(value as LtsStatus);
    } else {
      params[key] = value;
    }
  }

  const template = environmentFindingTemplatesEn[finding.code];
  return template ? formatMessage(template, params) : finding.code;
}

/** Bridge legacy doctor rows that still use free-text detail. */
export function checkResultToFinding(check: CheckResult): LegacyDetailFinding {
  return { code: LEGACY_DETAIL_CODE, params: { detail: check.detail } };
}

export function findingSeverity(finding: RuntimeFinding): CheckStatus {
  return FAIL_CODES.has(finding.code) ? 'fail' : 'warn';
}

export function runtimeHealthToCheckStatus(health: RuntimeHealth): CheckStatus {
  switch (health) {
    case 'ok':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'missing':
    case 'error':
      return 'fail';
    default:
      return 'fail';
  }
}
