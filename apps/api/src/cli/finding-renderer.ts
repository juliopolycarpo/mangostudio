/**
 * English rendering for structured runtime findings. The UI uses i18n; the CLI
 * uses the same English templates from shared messages so codes cannot drift.
 */

import type {
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

/** The English label of an LTS status code; undefined for a code this build does not know. */
function ltsLabel(status: string): string | undefined {
  return (environmentLtsLabelsEn as Record<string, string | undefined>)[status];
}

/** True when a rendered line still contains `{placeholder}` tokens. */
export function hasUnfilledPlaceholders(line: string): boolean {
  return /\{\w+\}/.test(line);
}

/**
 * A finding's params as its template reads them: identifiers become product
 * names, PATH indices one-based, and a version manager's `manager` stands in
 * for the `{runtime}` the shared `not-found` template names. An `ltsStatus`
 * stays the status code, since its words depend on the language it is shown in.
 */
export function findingParams(finding: RuntimeFinding): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(finding.params ?? {})) {
    if (IDENTIFIER_PARAMS.has(key)) {
      params[key] = displayName(value);
    } else if (PATH_INDEX_PARAMS.has(key)) {
      const parsed = Number(value);
      params[key] = Number.isFinite(parsed) ? String(pathPosition(parsed)) : value;
    } else {
      params[key] = value;
    }
  }

  // `not-found` is shared by runtimes and version managers, but its template
  // names the subject `{runtime}`; a version manager's finding carries
  // `manager` instead, so that name is the subject when no runtime is given.
  if (params.runtime === undefined && params.manager !== undefined) {
    params.runtime = params.manager;
  }
  return params;
}

/** Render one finding as a single English sentence for terminal output. */
export function renderFinding(finding: RenderableFinding): string {
  if (finding.code === LEGACY_DETAIL_CODE) {
    return finding.params.detail;
  }

  const params = findingParams(finding);
  if (params.ltsStatus !== undefined) {
    const label = ltsLabel(params.ltsStatus);
    // An unknown status keeps its placeholder, as a missing param always has.
    if (label === undefined) delete params.ltsStatus;
    else params.ltsStatus = label;
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
