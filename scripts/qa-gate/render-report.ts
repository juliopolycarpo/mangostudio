// Consolidated PR QA report renderer, run by the trusted publisher workflow
// with default-branch tooling only. Validates the untrusted qa-metrics
// artifacts against the report context (trusted values resolved from the
// GitHub API), renders the commit summary and changelog preview from fetched
// git data, and writes the final comment markdown to stdout.
//
// Usage: bun ./scripts/qa-gate/render-report.ts <context.json> [--head <metrics.json>] [--base <metrics.json>]

import { cliffArgs, renderChangelogPreviewSection } from '../lib/changelog';
import { ROOT_DIR } from '../lib/config';
import type { Metrics } from './collect/types';
import { COMMIT_LOG_FORMAT, parseCommitLog, renderCommitsSection } from './commit-log';
import {
  type EnvelopeParseOptions,
  type ExpectedEnvelope,
  parseQaMetricsEnvelope,
} from './metrics-envelope';
import { composeReport } from './report-document';

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

const parseArgs = (
  argv: readonly string[]
): { contextPath: string; headPath: string | null; basePath: string | null } => {
  const [contextPath, ...rest] = argv;
  const flagValue = (flag: string): string | null => {
    const index = rest.indexOf(flag);
    const value = index !== -1 ? rest[index + 1] : undefined;
    return value && !value.startsWith('--') ? value : null;
  };
  if (!contextPath) {
    process.stderr.write(
      'Usage: bun ./scripts/qa-gate/render-report.ts <context.json> [--head <metrics.json>] [--base <metrics.json>]\n'
    );
    process.exit(1);
  }
  return { contextPath, headPath: flagValue('--head'), basePath: flagValue('--base') };
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
  return renderChangelogPreviewSection(output);
};

const { contextPath, headPath, basePath } = parseArgs(process.argv.slice(2));
const context = JSON.parse(await Bun.file(contextPath).text()) as ReportContext;

const head = await loadMetrics(
  headPath,
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
  basePath,
  context.baseArtifact,
  {
    repository: context.repository,
    headSha: context.baseSha,
    baseSha: null,
    prNumber: null,
  },
  'base'
);

const report = composeReport(
  {
    headSha: context.headSha,
    baseSha: context.baseSha,
    runUrl: context.runUrl,
    headNote: head.note,
    baseNote: base.note,
  },
  {
    commits: renderCommits(context.baseSha, context.headSha),
    changelog: renderChangelog(context.baseSha, context.headSha),
  },
  base.metrics,
  head.metrics
);

process.stdout.write(`${report}\n`);
