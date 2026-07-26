// CI workflow duration comparison collected from the privileged Actions API
// side. Wall clock captures parallel elapsed time; the critical path is the
// longest completed job visible through the jobs API.

import type { CiDurationComparison, CiJobDuration, CiRunDurations } from '../ci-durations';
import { inlineCode, NA } from './format';

interface TimedJob {
  readonly job: CiJobDuration;
  readonly seconds: number;
}

const timestampMs = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const jobDurationSeconds = (job: CiJobDuration): number | null => {
  const started = timestampMs(job.startedAt);
  const completed = timestampMs(job.completedAt);
  if (started === null || completed === null || completed < started) return null;
  return (completed - started) / 1000;
};

const timedJobs = (run: CiRunDurations): TimedJob[] =>
  run.jobs
    .map((job) => {
      const seconds = jobDurationSeconds(job);
      return seconds === null ? null : { job, seconds };
    })
    .filter((job): job is TimedJob => job !== null);

const wallClockSeconds = (run: CiRunDurations): number | null => {
  const starts = run.jobs.map((job) => timestampMs(job.startedAt)).filter((time) => time !== null);
  const completions = run.jobs
    .map((job) => timestampMs(job.completedAt))
    .filter((time) => time !== null);
  if (starts.length === 0 || completions.length === 0) return null;
  const elapsed = Math.max(...completions) - Math.min(...starts);
  return elapsed < 0 ? null : elapsed / 1000;
};

const criticalJob = (run: CiRunDurations): TimedJob | null =>
  timedJobs(run).sort((left, right) => right.seconds - left.seconds)[0] ?? null;

const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return NA;
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
};

const renderDurationDelta = (base: number | null, head: number | null): string => {
  if (base === null || head === null) return NA;
  const delta = Math.round(head - base);
  if (delta === 0) return '⚪ ▲ = 0s';
  const slower = delta > 0;
  return `${slower ? '🔴 ▲ +' : '🟢 ▼ -'}${formatDuration(Math.abs(delta))}`;
};

const formatCriticalJob = (job: TimedJob | null): string =>
  job ? `${inlineCode(job.job.name)} · ${formatDuration(job.seconds)}` : NA;

const matchingDuration = (run: CiRunDurations, name: string): number | null => {
  const match = timedJobs(run).find(({ job }) => job.name === name);
  return match?.seconds ?? null;
};

const jobTimingCell = (run: CiRunDurations, name: string): string => {
  const job = run.jobs.find((candidate) => candidate.name === name);
  if (!job) return NA;
  const duration = jobDurationSeconds(job);
  if (duration !== null) return formatDuration(duration);
  if (job.status !== 'completed') return `${inlineCode(job.status)} (in flight)`;
  return job.conclusion === 'skipped' ? 'skipped' : 'timing unavailable';
};

const unavailableNote = (label: string, run: CiRunDurations): string | null =>
  run.error ? `> ${label} CI durations unavailable: ${inlineCode(run.error)}` : null;

const inFlightNote = (label: string, run: CiRunDurations): string | null => {
  const jobs = run.jobs.filter((job) => job.status !== 'completed');
  if (jobs.length === 0) return null;
  const rendered = jobs
    .map((job) => `${inlineCode(job.name)} (${inlineCode(job.status)})`)
    .join(', ');
  return `> ⏳ ${label} jobs still in flight: ${rendered}`;
};

const previousRunLine = (durations: CiDurationComparison): string => {
  const previous = wallClockSeconds(durations.previous);
  const head = wallClockSeconds(durations.head);
  if (previous !== null && head !== null) {
    return `**Since previous PR run:** ${formatDuration(previous)} → ${formatDuration(head)} (${renderDurationDelta(previous, head)})`;
  }
  const reason = durations.previous.error;
  return reason
    ? `**Since previous PR run:** ${NA} — ${inlineCode(reason)}`
    : `**Since previous PR run:** ${NA}`;
};

/** Render report-only CI timing details without contributing to the QA verdict. */
export const renderCiDurationSection = (
  durations: CiDurationComparison | null,
  note: string | null = null
): string => {
  if (!durations) {
    const detail = note ? ` ${inlineCode(note)}` : '';
    return [
      '<details>',
      '<summary>CI duration (unavailable)</summary>',
      '',
      `_${NA}.${detail}_`,
      '',
      '</details>',
    ].join('\n');
  }

  const baseWallClock = wallClockSeconds(durations.base);
  const headWallClock = wallClockSeconds(durations.head);
  const baseCritical = criticalJob(durations.base);
  const headCritical = criticalJob(durations.head);
  const slowest = timedJobs(durations.head)
    .sort((left, right) => right.seconds - left.seconds)
    .slice(0, 5);
  const notes = [
    unavailableNote('Base', durations.base),
    unavailableNote('Head', durations.head),
    unavailableNote('Previous PR run', durations.previous),
    inFlightNote('Base', durations.base),
    inFlightNote('Head', durations.head),
    inFlightNote('Previous PR run', durations.previous),
  ].filter((line): line is string => line !== null);

  const lines = [
    '<details>',
    '<summary>CI duration (wall clock, critical path, slowest jobs)</summary>',
    '',
    '### CI Duration',
    '',
    'Report-only timing from the Actions jobs API; runner variance does not affect the gate.',
    '',
    '| Metric | Base | Head | Δ |',
    '|---|---|---|---|',
    `| Total wall clock | ${formatDuration(baseWallClock)} | ${formatDuration(headWallClock)} | ${renderDurationDelta(baseWallClock, headWallClock)} |`,
    `| Critical path | ${formatCriticalJob(baseCritical)} | ${formatCriticalJob(headCritical)} | ${renderDurationDelta(baseCritical?.seconds ?? null, headCritical?.seconds ?? null)} |`,
    '',
    previousRunLine(durations),
    '',
    '#### Five slowest head jobs',
    '',
    '| Job | Base | Head | Δ |',
    '|---|---|---|---|',
  ];

  if (slowest.length === 0) {
    lines.push(`| ${NA} | ${NA} | ${NA} | ${NA} |`);
  } else {
    for (const { job, seconds } of slowest) {
      const baseSeconds = matchingDuration(durations.base, job.name);
      lines.push(
        `| ${inlineCode(job.name)} | ${jobTimingCell(durations.base, job.name)} | ${formatDuration(seconds)} | ${renderDurationDelta(baseSeconds, seconds)} |`
      );
    }
  }

  if (notes.length > 0) lines.push('', ...notes);
  lines.push('', '</details>');
  return lines.join('\n');
};
