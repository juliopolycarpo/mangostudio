// PR QA comment renderer, run by the trusted publisher workflow with
// default-branch tooling only. One invocation renders one of the two managed
// comments and writes its markdown to stdout, so a failure in one part never
// takes the other down:
// - `--part metrics`: validates the untrusted qa-metrics artifacts against the
//   report context (trusted values resolved from the GitHub API) and renders
//   the QA metrics comparison.
// - `--part commits`: renders the commit summary and changelog preview from
//   fetched git data.
//
// Usage: bun ./scripts/qa-gate/render-report.ts <context.json> --part metrics [--head <metrics.json>] [--base <metrics.json>] [--ci <ci-durations.json>]
//        bun ./scripts/qa-gate/render-report.ts <context.json> --part commits

import { cliffArgs } from '../lib/changelog';
import { ROOT_DIR } from '../lib/config';
import { type CiDurationComparison, parseCiDurationComparison } from './ci-durations';
import type { Metrics } from './collect/types';
import { COMMIT_LOG_FORMAT, parseCommitLog, renderCommitsSection } from './commit-log';
import {
  type EnvelopeParseOptions,
  type ExpectedEnvelope,
  parseQaMetricsEnvelope,
} from './metrics-envelope';
import {
  composeCommitsReport,
  composeMetricsReport,
  renderChangelogForComment,
} from './report-document';

interface ArtifactStatus {
  readonly found: boolean;
  readonly reason: string | null;
}

/** Trusted values the publisher resolved from the GitHub API (never from artifacts). */
interface ReportContext {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly runUrl: string;
  readonly headArtifact: ArtifactStatus;
  readonly baseArtifact: ArtifactStatus;
}

const stderr = (message: string): void => {
  process.stderr.write(`[render-report] ${message}\n`);
};

const REPORT_PARTS = ['metrics', 'commits'] as const;
type ReportPart = (typeof REPORT_PARTS)[number];

const USAGE =
  'Usage: bun ./scripts/qa-gate/render-report.ts <context.json> --part <metrics|commits> [--head <metrics.json>] [--base <metrics.json>] [--ci <ci-durations.json>]\n';

const parseArgs = (
  argv: readonly string[]
): {
  contextPath: string;
  part: ReportPart;
  headPath: string | null;
  basePath: string | null;
  ciPath: string | null;
} => {
  const [contextPath, ...rest] = argv;
  const flagValue = (flag: string): string | null => {
    const index = rest.indexOf(flag);
    const value = index !== -1 ? rest[index + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
  };
  const part = flagValue('--part');
  if (!contextPath || !REPORT_PARTS.includes(part as ReportPart)) {
    process.stderr.write(
      `${USAGE}Received --part ${JSON.stringify(part)}; expected one of ${REPORT_PARTS.join(', ')}.\n`
    );
    process.exit(1);
  }
  return {
    contextPath,
    part: part as ReportPart,
    headPath: flagValue('--head'),
    basePath: flagValue('--base'),
    ciPath: flagValue('--ci'),
  };
};

const loadMetrics = async (
  path: string | null,
  artifact: ArtifactStatus,
  expected: ExpectedEnvelope,
  side: 'head' | 'base',
  options: EnvelopeParseOptions = {}
): Promise<{ metrics: Metrics | null; note: string | null }> => {
  if (!artifact.found) return { metrics: null, note: artifact.reason ?? 'artifact not found' };
  if (!path || !(await Bun.file(path).exists())) {
    return { metrics: null, note: 'artifact payload could not be extracted' };
  }
  try {
    const envelope = parseQaMetricsEnvelope(await Bun.file(path).text(), expected, options);
    return { metrics: envelope.metrics, note: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr(`${side} metrics rejected: ${message}`);
    return { metrics: null, note: message };
  }
};

const runCaptured = (cmd: readonly string[]): string | null => {
  const proc = Bun.spawnSync({ cmd: [...cmd], cwd: ROOT_DIR, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    stderr(`${cmd[0]} failed: ${proc.stderr.toString().slice(0, 2000)}`);
    return null;
  }
  return proc.stdout.toString();
};

const renderCommits = (baseSha: string, headSha: string): string | null => {
  const log = runCaptured([
    'git',
    'log',
    '--reverse',
    `--format=${COMMIT_LOG_FORMAT}`,
    `${baseSha}..${headSha}`,
  ]);
  if (log === null) return null;
  return renderCommitsSection(parseCommitLog(log), { baseSha, headSha });
};

const renderChangelog = (baseSha: string, headSha: string): string | null => {
  const output = runCaptured([
    'bunx',
    'git-cliff',
    ...cliffArgs({ kind: 'preview', base: baseSha, head: headSha }),
  ]);
  if (output === null) return null;
  return renderChangelogForComment(output);
};

const loadCiDurations = async (
  path: string | null
): Promise<{ durations: CiDurationComparison | null; note: string | null }> => {
  if (!path || !(await Bun.file(path).exists())) {
    return { durations: null, note: 'CI duration payload was not produced' };
  }
  try {
    return { durations: parseCiDurationComparison(await Bun.file(path).text()), note: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`CI durations rejected: ${message}`);
    return { durations: null, note: message };
  }
};

const renderMetricsPart = async (
  context: ReportContext,
  paths: { headPath: string | null; basePath: string | null; ciPath: string | null }
): Promise<string> => {
  const head = await loadMetrics(
    paths.headPath,
    context.headArtifact,
    {
      repository: context.repository,
      headSha: context.headSha,
      baseSha: context.baseSha,
      prNumber: context.prNumber,
    },
    'head',
    // #516: a PR base.sha follows the live base tip and can advance after head collection.
    { enforceBaseSha: false }
  );
  const base = await loadMetrics(
    paths.basePath,
    context.baseArtifact,
    {
      repository: context.repository,
      headSha: context.baseSha,
      baseSha: null,
      prNumber: null,
    },
    'base'
  );
  const ci = await loadCiDurations(paths.ciPath);

  return composeMetricsReport(
    {
      headSha: context.headSha,
      baseSha: context.baseSha,
      runUrl: context.runUrl,
      headNote: head.note,
      baseNote: base.note,
    },
    base.metrics,
    head.metrics,
    ci.durations,
    ci.note
  );
};

const renderCommitsPart = (context: ReportContext): string =>
  composeCommitsReport({
    commits: renderCommits(context.baseSha, context.headSha),
    changelog: renderChangelog(context.baseSha, context.headSha),
  });

const { contextPath, part, headPath, basePath, ciPath } = parseArgs(process.argv.slice(2));
const context = JSON.parse(await Bun.file(contextPath).text()) as ReportContext;

const report =
  part === 'metrics'
    ? await renderMetricsPart(context, { headPath, basePath, ciPath })
    : renderCommitsPart(context);

process.stdout.write(`${report}\n`);
