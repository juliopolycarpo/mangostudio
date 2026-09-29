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
import { COMMIT_LOG_FORMAT, parseCommitLog, renderCommitsSection } from './commit-log';
import { type ArtifactStatus, loadMetrics } from './load-metrics';
import {
  composeCommitsReport,
  composeMetricsReport,
  renderChangelogForComment,
} from './report-document';

/** Trusted values the publisher resolved from the GitHub API (never from artifacts). */
export interface ReportContext {
  readonly repository: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  /** True when `baseSha` is the base the head envelope recorded, so the envelope must match it. */
  readonly baseShaRecorded?: boolean;
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

interface ReportArgs {
  readonly contextPath: string;
  readonly part: ReportPart;
  readonly headPath: string | null;
  readonly basePath: string | null;
  readonly ciPath: string | null;
}

/** The arguments, or the usage message naming what was received and what was expected. */
const parseArgs = (argv: readonly string[]): ReportArgs | { readonly error: string } => {
  const [contextPath, ...rest] = argv;
  const flagValue = (flag: string): string | null => {
    const index = rest.indexOf(flag);
    const value = index !== -1 ? rest[index + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
  };
  const part = flagValue('--part');
  if (!contextPath || !REPORT_PARTS.includes(part as ReportPart)) {
    return {
      error: `${USAGE}Received context ${JSON.stringify(contextPath ?? null)} and --part ${JSON.stringify(part)}; expected a context path and --part one of ${REPORT_PARTS.join(', ')}.\n`,
    };
  }
  return {
    contextPath,
    part: part as ReportPart,
    headPath: flagValue('--head'),
    basePath: flagValue('--base'),
    ciPath: flagValue('--ci'),
  };
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
    // The publisher resolved the base from the head envelope itself, so it must match exactly.
    // Without a recorded base (`baseSha` is only the live tip, which can advance after head
    // collection, #516) there is nothing to compare against.
    { enforceBaseSha: context.baseShaRecorded === true },
    stderr
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
    'base',
    {},
    stderr
  );
  const ci = await loadCiDurations(paths.ciPath);

  return composeMetricsReport(
    {
      headSha: context.headSha,
      baseSha: context.baseSha,
      runUrl: context.runUrl,
      headNote: head.note,
      baseNote: base.note,
      baseIncomparable: base.incomparable,
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

/** Everything `main` reads, renders or writes, so a test can run it without a checkout or git. */
export interface RenderReportDeps {
  /** Text of the context file at `path`. */
  readonly readText: (path: string) => Promise<string>;
  readonly renderMetrics: (
    context: ReportContext,
    paths: { headPath: string | null; basePath: string | null; ciPath: string | null }
  ) => Promise<string>;
  readonly renderCommits: (context: ReportContext) => string;
  /** Writes the rendered markdown to stdout. */
  readonly write: (text: string) => void;
  /** Writes a usage error to stderr. */
  readonly writeError: (text: string) => void;
}

/**
 * Render one managed comment part and write its markdown. Returns the process
 * exit code: 0 after rendering, 1 for a missing context path or an unknown
 * `--part`.
 * // Usage: process.exitCode = await main(process.argv.slice(2), realDeps);
 */
export const main = async (argv: readonly string[], deps: RenderReportDeps): Promise<number> => {
  const args = parseArgs(argv);
  if ('error' in args) {
    deps.writeError(args.error);
    return 1;
  }
  const context = JSON.parse(await deps.readText(args.contextPath)) as ReportContext;
  const report =
    args.part === 'metrics' ? await deps.renderMetrics(context, args) : deps.renderCommits(context);
  deps.write(`${report}\n`);
  return 0;
};

if (import.meta.main) {
  // exitCode, not process.exit: a large report on a pipe must finish flushing first.
  process.exitCode = await main(process.argv.slice(2), {
    readText: (path) => Bun.file(path).text(),
    renderMetrics: renderMetricsPart,
    renderCommits: renderCommitsPart,
    write: (text) => {
      process.stdout.write(text);
    },
    writeError: (text) => {
      process.stderr.write(text);
    },
  });
}
