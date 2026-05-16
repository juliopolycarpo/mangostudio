import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../lib/config';
import type { CoverageSummary, CoverageBucket } from './parse-lcov';
import type {
  BundleStats,
  DependencyStats,
  Failable,
  LocBucket,
  Metrics,
  TestLaneStats,
} from './collect';

const [, , baseArg, headArg] = process.argv;
if (!baseArg || !headArg) {
  process.stderr.write('Usage: bun ./scripts/qa-gate/render.ts <base.json> <head.json>\n');
  process.exit(1);
}

const COMMENT_MARKER = '<!-- qa-gate-comment -->';

const COVERAGE_KEYS = ['lines', 'statements', 'functions', 'branches'] as const;
type CoverageKey = (typeof COVERAGE_KEYS)[number];

const WORKSPACE_ORDER: readonly (WorkspaceName | 'total')[] = [...ALL_WORKSPACE_NAMES, 'total'];

// ── Loaders ──

const loadMetrics = async (path: string): Promise<Metrics | null> => {
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as Metrics;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[render] failed to load ${path}: ${message}\n`);
    return null;
  }
};

const [baseMetrics, headMetrics] = await Promise.all([loadMetrics(baseArg), loadMetrics(headArg)]);

// ── Formatters ──

const NA = 'n/a';

const isError = <T>(value: Failable<T> | null | undefined): value is { error: string } => {
  return typeof value === 'object' && value !== null && 'error' in value;
};

const ok = <T>(value: Failable<T> | null | undefined): value is T => {
  return value !== null && value !== undefined && !isError(value);
};

const shortSha = (sha: string | undefined): string => (sha ? sha.slice(0, 7) : NA);

const formatNumber = (value: number): string => value.toLocaleString('en-US');

const formatPct = (value: number): string => `${value.toFixed(2)}%`;

const formatBytes = (value: number): string => {
  if (value < 1024) return `${formatNumber(value)} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
};

interface DeltaOptions {
  readonly higherIsBetter: boolean;
  readonly suffix?: string;
  readonly precision?: number;
}

const renderDelta = (
  baseValue: number | null | undefined,
  headValue: number | null | undefined,
  opts: DeltaOptions
): string => {
  if (baseValue == null || headValue == null) return NA;
  const diff = headValue - baseValue;
  if (Math.abs(diff) < 1e-9) return '—';
  const precision = opts.precision ?? 2;
  const sign = diff > 0 ? '+' : '';
  const magnitude = `${sign}${diff.toFixed(precision).replace(/\.00$/, '')}${opts.suffix ?? ''}`;
  const isGood = opts.higherIsBetter ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const tag = isGood ? '🟢' : '🔴';
  return `${tag} ${arrow} ${magnitude}`;
};

const renderByteDelta = (
  baseValue: number | null | undefined,
  headValue: number | null | undefined
): string => {
  if (baseValue == null || headValue == null) return NA;
  const diff = headValue - baseValue;
  if (diff === 0) return '—';
  const sign = diff > 0 ? '+' : '-';
  const isGood = diff < 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const tag = isGood ? '🟢' : '🔴';
  return `${tag} ${arrow} ${sign}${formatBytes(Math.abs(diff))}`;
};

// ── Coverage table ──

const getCoverageBucket = (
  summary: Failable<CoverageSummary> | undefined,
  key: CoverageKey
): CoverageBucket | null => {
  if (!ok(summary)) return null;
  const bucket = summary[key];
  return bucket ?? null;
};

const renderCoverageRow = (workspace: WorkspaceName, key: CoverageKey): string => {
  const baseBucket = getCoverageBucket(baseMetrics?.coverage?.[workspace], key);
  const headBucket = getCoverageBucket(headMetrics?.coverage?.[workspace], key);
  const basePct = baseBucket?.pct ?? null;
  const headPct = headBucket?.pct ?? null;
  const baseCell = baseBucket
    ? `${formatPct(baseBucket.pct)} (${formatNumber(baseBucket.covered)}/${formatNumber(baseBucket.total)})`
    : NA;
  const headCell = headBucket
    ? `${formatPct(headBucket.pct)} (${formatNumber(headBucket.covered)}/${formatNumber(headBucket.total)})`
    : NA;
  const delta = renderDelta(basePct, headPct, { higherIsBetter: true, suffix: 'pp' });
  return `| ${workspace} | ${key} | ${baseCell} | ${headCell} | ${delta} |`;
};

const renderCoverageSection = (): string => {
  const rows: string[] = [];
  for (const workspace of ALL_WORKSPACE_NAMES) {
    for (const key of COVERAGE_KEYS) {
      rows.push(renderCoverageRow(workspace, key));
    }
  }
  return [
    '### Coverage',
    '',
    '| Workspace | Metric | Base | Head | Δ |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};

// ── LoC table ──

const getLoc = (metrics: Metrics | null, workspace: WorkspaceName | 'total'): LocBucket | null => {
  const entry = metrics?.loc?.[workspace];
  return ok(entry) ? entry : null;
};

const renderLocRow = (workspace: WorkspaceName | 'total'): string => {
  const baseLoc = getLoc(baseMetrics, workspace);
  const headLoc = getLoc(headMetrics, workspace);
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

const renderLocSection = (): string => {
  return [
    '### Lines of Code',
    '',
    '| Workspace | Base | Head | Δ |',
    '|---|---|---|---|',
    ...WORKSPACE_ORDER.map(renderLocRow),
    '',
  ].join('\n');
};

// ── Duplication ──

const renderDuplicationSection = (): string => {
  const baseDup = ok(baseMetrics?.duplication) ? baseMetrics.duplication : null;
  const headDup = ok(headMetrics?.duplication) ? headMetrics.duplication : null;

  const rows: string[] = [];
  rows.push(
    `| clones | ${baseDup ? formatNumber(baseDup.clones) : NA} | ${headDup ? formatNumber(headDup.clones) : NA} | ${renderDelta(baseDup?.clones, headDup?.clones, { higherIsBetter: false, precision: 0 })} |`
  );
  rows.push(
    `| duplicated lines | ${baseDup ? formatNumber(baseDup.duplicatedLines) : NA} | ${headDup ? formatNumber(headDup.duplicatedLines) : NA} | ${renderDelta(baseDup?.duplicatedLines, headDup?.duplicatedLines, { higherIsBetter: false, precision: 0 })} |`
  );
  rows.push(
    `| percentage | ${baseDup ? formatPct(baseDup.percentage) : NA} | ${headDup ? formatPct(headDup.percentage) : NA} | ${renderDelta(baseDup?.percentage, headDup?.percentage, { higherIsBetter: false, suffix: 'pp' })} |`
  );

  return [
    '### Code Duplication (jscpd)',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};

// ── Bundle size ──

const getBundle = (metrics: Metrics | null): BundleStats | null => {
  return ok(metrics?.frontendBundle) ? metrics.frontendBundle : null;
};

const renderBundleRow = (
  label: string,
  selector: (bundle: BundleStats) => number,
  opts: { readonly bytes: boolean } = { bytes: true }
): string => {
  const baseBundle = getBundle(baseMetrics);
  const headBundle = getBundle(headMetrics);
  const baseValue = baseBundle ? selector(baseBundle) : null;
  const headValue = headBundle ? selector(headBundle) : null;
  const format = opts.bytes ? formatBytes : formatNumber;
  const delta = opts.bytes
    ? renderByteDelta(baseValue, headValue)
    : renderDelta(baseValue, headValue, { higherIsBetter: false, precision: 0 });
  return `| ${label} | ${baseValue == null ? NA : format(baseValue)} | ${headValue == null ? NA : format(headValue)} | ${delta} |`;
};

const renderBundleSection = (): string => {
  return [
    '### Frontend Bundle',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    renderBundleRow('gzip total', (bundle) => bundle.gzipBytes),
    renderBundleRow('gzip JavaScript', (bundle) => bundle.jsGzipBytes),
    renderBundleRow('gzip CSS', (bundle) => bundle.cssGzipBytes),
    renderBundleRow('gzip HTML', (bundle) => bundle.htmlGzipBytes),
    renderBundleRow('tracked files', (bundle) => bundle.files, { bytes: false }),
    '',
  ].join('\n');
};

// ── Dependencies ──

const getDependencies = (metrics: Metrics | null): DependencyStats | null => {
  return ok(metrics?.dependencies) ? metrics.dependencies : null;
};

const renderDependencyRow = (
  label: string,
  selector: (dependencies: DependencyStats) => number
): string => {
  const baseDependencies = getDependencies(baseMetrics);
  const headDependencies = getDependencies(headMetrics);
  const baseValue = baseDependencies ? selector(baseDependencies) : null;
  const headValue = headDependencies ? selector(headDependencies) : null;
  return `| ${label} | ${baseValue == null ? NA : formatNumber(baseValue)} | ${headValue == null ? NA : formatNumber(headValue)} | ${renderDelta(baseValue, headValue, { higherIsBetter: false, precision: 0 })} |`;
};

const renderDependenciesSection = (): string => {
  return [
    '### Dependencies',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    renderDependencyRow('locked packages', (dependencies) => dependencies.lockedPackages),
    renderDependencyRow('direct dependencies', (dependencies) => dependencies.directDependencies),
    renderDependencyRow(
      'direct devDependencies',
      (dependencies) => dependencies.directDevDependencies
    ),
    renderDependencyRow('workspace manifests', (dependencies) => dependencies.workspaceManifests),
    '',
  ].join('\n');
};

// ── Tests ──

const getTestLane = (
  metrics: Metrics | null,
  lane: 'unit' | 'integration'
): TestLaneStats | null => {
  return ok(metrics?.tests?.[lane]) ? metrics.tests[lane] : null;
};

const formatTestBreakdown = (lane: TestLaneStats | null): string => {
  if (!lane) return NA;
  const parts = [
    `root ${formatNumber(lane.root)}`,
    `frontend ${formatNumber(lane.frontend)}`,
    `api ${formatNumber(lane.api)}`,
    `shared ${formatNumber(lane.shared)}`,
  ];
  const status = lane.exitCode == null ? 'status n/a' : `exit ${lane.exitCode}`;
  return `${formatNumber(lane.passed)} passed (${parts.join(' / ')}) · ${status}`;
};

const renderTestLaneRow = (lane: 'unit' | 'integration'): string => {
  const baseLane = getTestLane(baseMetrics, lane);
  const headLane = getTestLane(headMetrics, lane);
  return `| ${lane} | ${formatTestBreakdown(baseLane)} | ${formatTestBreakdown(headLane)} | ${renderDelta(baseLane?.passed, headLane?.passed, { higherIsBetter: true, precision: 0 })} |`;
};

const renderTestsSection = (): string => {
  return [
    '### Tests by Lane',
    '',
    '| Lane | Base | Head | Δ passed |',
    '|---|---|---|---|',
    renderTestLaneRow('unit'),
    renderTestLaneRow('integration'),
    '',
  ].join('\n');
};

// ── Violations & Warnings ──

const sumTsErrors = (metrics: Metrics | null): number | null => {
  if (!metrics) return null;
  let sum = 0;
  for (const workspace of ALL_WORKSPACE_NAMES) {
    const entry = metrics.tsErrors[workspace];
    if (!ok(entry)) return null;
    sum += entry;
  }
  return sum;
};

const renderViolationsSection = (): string => {
  const baseEslint = ok(baseMetrics?.eslint) ? baseMetrics.eslint : null;
  const headEslint = ok(headMetrics?.eslint) ? headMetrics.eslint : null;
  const baseTs = sumTsErrors(baseMetrics);
  const headTs = sumTsErrors(headMetrics);
  const baseCirc = ok(baseMetrics?.circularDeps) ? baseMetrics.circularDeps : null;
  const headCirc = ok(headMetrics?.circularDeps) ? headMetrics.circularDeps : null;

  const rows: string[] = [];
  const numCell = (value: number | null) => (value == null ? NA : formatNumber(value));
  rows.push(
    `| ESLint errors | ${numCell(baseEslint?.errors ?? null)} | ${numCell(headEslint?.errors ?? null)} | ${renderDelta(baseEslint?.errors, headEslint?.errors, { higherIsBetter: false, precision: 0 })} |`
  );
  rows.push(
    `| ESLint warnings | ${numCell(baseEslint?.warnings ?? null)} | ${numCell(headEslint?.warnings ?? null)} | ${renderDelta(baseEslint?.warnings, headEslint?.warnings, { higherIsBetter: false, precision: 0 })} |`
  );
  rows.push(
    `| TS errors (total) | ${numCell(baseTs)} | ${numCell(headTs)} | ${renderDelta(baseTs, headTs, { higherIsBetter: false, precision: 0 })} |`
  );
  rows.push(
    `| Circular dependencies | ${numCell(baseCirc)} | ${numCell(headCirc)} | ${renderDelta(baseCirc, headCirc, { higherIsBetter: false, precision: 0 })} |`
  );

  return [
    '### Violations & Warnings',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
};

// ── Summary row ──

const renderSummary = (): string => {
  const baseLoc = getLoc(baseMetrics, 'total');
  const headLoc = getLoc(headMetrics, 'total');
  const baseFrontLines = getCoverageBucket(baseMetrics?.coverage?.frontend, 'lines')?.pct ?? null;
  const headFrontLines = getCoverageBucket(headMetrics?.coverage?.frontend, 'lines')?.pct ?? null;
  const baseEslint = ok(baseMetrics?.eslint) ? baseMetrics.eslint.errors : null;
  const headEslint = ok(headMetrics?.eslint) ? headMetrics.eslint.errors : null;
  const baseDupPct = ok(baseMetrics?.duplication) ? baseMetrics.duplication.percentage : null;
  const headDupPct = ok(headMetrics?.duplication) ? headMetrics.duplication.percentage : null;
  const baseBundle = getBundle(baseMetrics);
  const headBundle = getBundle(headMetrics);
  const baseDeps = getDependencies(baseMetrics);
  const headDeps = getDependencies(headMetrics);
  const baseUnit = getTestLane(baseMetrics, 'unit');
  const headUnit = getTestLane(headMetrics, 'unit');

  const bits: string[] = [];
  bits.push(
    `**LoC (code):** ${renderDelta(baseLoc?.code, headLoc?.code, { higherIsBetter: false, precision: 0 })}`
  );
  bits.push(
    `**Frontend line coverage:** ${renderDelta(baseFrontLines, headFrontLines, { higherIsBetter: true, suffix: 'pp' })}`
  );
  bits.push(
    `**ESLint errors:** ${renderDelta(baseEslint, headEslint, { higherIsBetter: false, precision: 0 })}`
  );
  bits.push(
    `**Duplication:** ${renderDelta(baseDupPct, headDupPct, { higherIsBetter: false, suffix: 'pp' })}`
  );
  bits.push(`**Bundle gzip:** ${renderByteDelta(baseBundle?.gzipBytes, headBundle?.gzipBytes)}`);
  bits.push(
    `**Locked deps:** ${renderDelta(baseDeps?.lockedPackages, headDeps?.lockedPackages, { higherIsBetter: false, precision: 0 })}`
  );
  bits.push(
    `**Unit tests:** ${renderDelta(baseUnit?.passed, headUnit?.passed, { higherIsBetter: true, precision: 0 })}`
  );

  return bits.join(' • ');
};

// ── Document ──

const baseSha = shortSha(baseMetrics?.sha);
const headSha = shortSha(headMetrics?.sha);
const generated = headMetrics?.generatedAt ?? baseMetrics?.generatedAt ?? new Date().toISOString();

const errorNotes: string[] = [];
for (const [side, metrics] of [
  ['base', baseMetrics],
  ['head', headMetrics],
] as const) {
  if (!metrics) {
    errorNotes.push(`- **${side}** metrics file was not loadable.`);
    continue;
  }
  for (const workspace of ALL_WORKSPACE_NAMES) {
    const cov = metrics.coverage[workspace];
    if (isError(cov)) errorNotes.push(`- ${side}/coverage/${workspace}: \`${cov.error}\``);
    const ts = metrics.tsErrors[workspace];
    if (isError(ts)) errorNotes.push(`- ${side}/tsErrors/${workspace}: \`${ts.error}\``);
    const loc = metrics.loc[workspace];
    if (isError(loc)) errorNotes.push(`- ${side}/loc/${workspace}: \`${loc.error}\``);
  }
  if (isError(metrics.eslint)) errorNotes.push(`- ${side}/eslint: \`${metrics.eslint.error}\``);
  if (isError(metrics.duplication))
    errorNotes.push(`- ${side}/duplication: \`${metrics.duplication.error}\``);
  if (isError(metrics.circularDeps))
    errorNotes.push(`- ${side}/circularDeps: \`${metrics.circularDeps.error}\``);
  if (isError(metrics.frontendBundle))
    errorNotes.push(`- ${side}/frontendBundle: \`${metrics.frontendBundle.error}\``);
  if (isError(metrics.dependencies))
    errorNotes.push(`- ${side}/dependencies: \`${metrics.dependencies.error}\``);
  for (const lane of ['unit', 'integration'] as const) {
    const tests = metrics.tests?.[lane];
    if (isError(tests)) errorNotes.push(`- ${side}/tests/${lane}: \`${tests.error}\``);
  }
}

const lines: string[] = [];
lines.push('## QA Gate — Coverage & Quality');
lines.push('');
lines.push(`**Base:** \`${baseSha}\` • **Head:** \`${headSha}\` • _generated ${generated}_`);
lines.push('');
lines.push(renderSummary());
lines.push('');
lines.push(renderCoverageSection());
lines.push(renderLocSection());
lines.push(renderBundleSection());
lines.push(renderDependenciesSection());
lines.push(renderTestsSection());
lines.push(renderDuplicationSection());
lines.push(renderViolationsSection());

if (errorNotes.length > 0) {
  lines.push('<details>');
  lines.push('<summary>Collector errors (non-fatal)</summary>');
  lines.push('');
  lines.push(...errorNotes);
  lines.push('');
  lines.push('</details>');
  lines.push('');
}

lines.push('<details>');
lines.push('<summary>Out-of-scope (potential follow-ups)</summary>');
lines.push('');
lines.push('- Branches & statements for the API workspace (Bun LCOV does not emit them).');
lines.push('- Per-chunk bundle deltas for the largest frontend assets.');
lines.push('- Runtime startup and first-load smoke timings.');
lines.push('');
lines.push('</details>');
lines.push('');
lines.push(COMMENT_MARKER);

process.stdout.write(`${lines.join('\n')}\n`);
