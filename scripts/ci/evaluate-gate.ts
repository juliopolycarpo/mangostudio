#!/usr/bin/env bun
// Aggregate-gate evaluator for the workflow fan-in jobs named "Gate". GitHub
// exposes dependency outcomes only through the `needs` context, and encoding
// the accept/reject rules in a YAML `if:` expression is fragile and
// untestable, so the gate jobs feed that context to this script instead.
//
// Rules: `success` always passes; `skipped` passes only for jobs listed in
// ALLOWED_SKIPS (a declared conditional lane whose relevance predicate
// evaluated false for this run); anything else — failure, cancellation, or an
// unexpected skip — fails the gate.
//
// Light lane set: a gate on a workflow that ran only the light lanes for a
// Dependabot pull request reports those lanes' real results and then fails
// anyway, with LIGHT_REFUSAL as the message. A light run therefore never
// merges. The refusal is deliberate and the lane failure is not, so the two
// are reported apart (`lanesOk`, and the CLI's separate messages).
//
// This file must stay dependency-free (Node built-ins and ../lib/lane-mode):
// the gate jobs run it straight from a checkout without `bun install`.
// Usage: NEEDS='{"test":{"result":"success"}}' ALLOWED_SKIPS='qa-metrics' LANE_SET=full bun ./scripts/ci/evaluate-gate.ts

import { appendFileSync } from 'node:fs';

import { type LaneSet, LIGHT_REFUSAL, parseLaneSet } from '../lib/lane-mode';

const NEED_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const;

export type NeedResult = (typeof NEED_RESULTS)[number];

export interface GateVerdict {
  /** The gate's pass/fail. Always false for the light lane set. */
  readonly ok: boolean;
  readonly lines: readonly string[];
  /** Whether every dependency met the accept rules, independent of the lane set. */
  readonly lanesOk: boolean;
  readonly laneSet: LaneSet;
}

/** Parse the `toJSON(needs)` payload into a job → result map. */
export function parseNeeds(raw: string | undefined): Record<string, NeedResult> {
  if (!raw) throw new Error('NEEDS is required; pass `toJSON(needs)` from the gate job');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('NEEDS is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NEEDS must be the JSON object form of the `needs` context');
  }

  const results: Record<string, NeedResult> = {};
  for (const [job, entry] of Object.entries(parsed)) {
    const result = (entry as { result?: unknown } | null)?.result;
    if (typeof result !== 'string' || !NEED_RESULTS.includes(result as NeedResult)) {
      throw new Error(`needs entry "${job}" has an unrecognized result: ${JSON.stringify(result)}`);
    }
    results[job] = result as NeedResult;
  }
  return results;
}

/** Parse the whitespace/comma-separated ALLOWED_SKIPS job list. */
export function parseAllowedSkips(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(/[\s,]+/).filter(Boolean));
}

export function evaluateGate(
  results: Readonly<Record<string, NeedResult>>,
  allowedSkips: ReadonlySet<string>,
  laneSet: LaneSet = 'full'
): GateVerdict {
  const jobs = Object.keys(results);
  if (jobs.length === 0) {
    return {
      ok: false,
      lanesOk: false,
      laneSet,
      lines: ['gate has no dependencies to evaluate; its `needs` list is misconfigured'],
    };
  }

  const lines: string[] = [];
  let ok = true;

  // An allowed-skip name that is not a dependency is configuration drift (a
  // renamed job or a stale ALLOWED_SKIPS expression), not a passing gate.
  for (const name of allowedSkips) {
    if (!(name in results)) {
      ok = false;
      lines.push(`allowed-skip job "${name}" is not a gate dependency; fix ALLOWED_SKIPS or needs`);
    }
  }

  for (const job of jobs) {
    const result = results[job];
    if (result === 'success') {
      lines.push(`${job}: success`);
    } else if (result === 'skipped' && allowedSkips.has(job)) {
      lines.push(`${job}: skipped (accepted: lane not relevant to this run)`);
    } else {
      ok = false;
      lines.push(`${job}: ${result} — mandatory job did not succeed`);
    }
  }

  return { ok: ok && laneSet === 'full', lanesOk: ok, laneSet, lines };
}

/** Markdown for the job summary of a light-lane gate: the lane results, then why it still fails. */
export function renderLightSummary(verdict: GateVerdict): string {
  const heading = verdict.lanesOk
    ? '### Gate refused: light lane set (no lane failed)'
    : '### Gate failed: a light lane did not succeed (the light lane set also refuses)';
  return [
    heading,
    '',
    LIGHT_REFUSAL,
    '',
    'Light lane results:',
    '',
    ...verdict.lines.map((line) => `- ${line}`),
    '',
  ].join('\n');
}

// Reused skips: a job that did not run because a pull request run already
// tested this exact tree (docs/reference/ci.md, "Tree reuse shadow"). It is its
// own vocabulary beside ALLOWED_SKIPS, which says "this lane is not relevant":
// a reused skip is only as good as its proof, so it needs REUSE_RUN (the
// proving run) and REUSE_TREE (what it tested) and must really be a skip. No
// workflow sets any of the three yet.

/** The `REUSED_SKIPS`, `REUSE_RUN` and `REUSE_TREE` inputs. */
export interface ReuseInput {
  readonly reusedSkips: ReadonlySet<string>;
  /** ID of the pull request CI run that tested the tree; empty when there is no proof. */
  readonly run: string;
  /** The tree SHA that run tested. */
  readonly tree: string;
}

/** Read the three reuse inputs from an environment; absent ones are empty, which means no reuse. */
export function parseReuseInput(env: Readonly<Record<string, string | undefined>>): ReuseInput {
  return {
    reusedSkips: parseAllowedSkips(env.REUSED_SKIPS),
    run: (env.REUSE_RUN ?? '').trim(),
    tree: (env.REUSE_TREE ?? '').trim(),
  };
}

/**
 * `evaluateGate` plus reused skips. With no REUSED_SKIPS it is `evaluateGate`
 * unchanged. A job listed there passes only as `skipped`, and only when the
 * proof inputs are present; the gate fails when
 *
 * - REUSE_RUN or REUSE_TREE is empty (a reused skip with no proof),
 * - the job did not skip (the reuse decision and the job disagree), whatever it did instead,
 * - the job is not a gate dependency (stale configuration), or
 * - the job is also in ALLOWED_SKIPS (two reasons for one skip).
 *
 * Reused jobs are judged here and left out of the ordinary evaluation, so
 * `evaluateGate` and its message for an unexpected skip stay as they are.
 */
export function evaluateGateWithReuse(
  results: Readonly<Record<string, NeedResult>>,
  allowedSkips: ReadonlySet<string>,
  reuse: ReuseInput,
  laneSet: LaneSet = 'full'
): GateVerdict {
  if (reuse.reusedSkips.size === 0) return evaluateGate(results, allowedSkips, laneSet);

  const ordinary: Record<string, NeedResult> = {};
  for (const [job, result] of Object.entries(results)) {
    if (!reuse.reusedSkips.has(job)) ordinary[job] = result;
  }
  const base = evaluateGate(ordinary, allowedSkips, laneSet);

  const lines = [...base.lines];
  let ok = base.ok;
  // One verdict line naming the missing proof beats one per job.
  const missing = [
    reuse.run === '' ? 'REUSE_RUN' : undefined,
    reuse.tree === '' ? 'REUSE_TREE' : undefined,
  ].filter((name) => name !== undefined);
  if (missing.length > 0) {
    ok = false;
    lines.push(
      `REUSED_SKIPS lists ${[...reuse.reusedSkips].join(', ')} but ${missing.join(' and ')} is empty; a reused skip needs the proving run and tree`
    );
  }

  for (const job of reuse.reusedSkips) {
    const result = results[job];
    if (result === undefined) {
      ok = false;
      lines.push(`reused-skip job "${job}" is not a gate dependency; fix REUSED_SKIPS or needs`);
    } else if (allowedSkips.has(job)) {
      ok = false;
      lines.push(`${job}: listed in both ALLOWED_SKIPS and REUSED_SKIPS; a skip has one reason`);
    } else if (result !== 'skipped') {
      ok = false;
      lines.push(`${job}: ${result} — listed in REUSED_SKIPS but did not skip`);
    } else if (missing.length > 0) {
      lines.push(`${job}: skipped — reused skip without proof`);
    } else {
      lines.push(
        `${job}: skipped (reused: pull request run ${reuse.run} tested tree ${reuse.tree})`
      );
    }
  }

  // The lane-set fields of the ordinary verdict pass through unchanged.
  return { ...base, ok, lines };
}

if (import.meta.main) {
  try {
    const verdict = evaluateGateWithReuse(
      parseNeeds(process.env.NEEDS),
      parseAllowedSkips(process.env.ALLOWED_SKIPS),
      parseReuseInput(process.env),
      parseLaneSet(process.env.LANE_SET)
    );
    for (const line of verdict.lines) console.log(line);
    if (verdict.laneSet === 'light') {
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderLightSummary(verdict));
      }
      // A lane failure and the deliberate refusal are different problems with
      // different fixes, so they never share a message.
      if (!verdict.lanesOk) {
        console.error('Gate: light lane failure: at least one light lane did not succeed.');
      }
      console.error(
        verdict.lanesOk
          ? `Gate: refused, no lane failed: ${LIGHT_REFUSAL}`
          : `Gate: also refused: ${LIGHT_REFUSAL}`
      );
      process.exit(1);
    }
    if (!verdict.ok) {
      console.error('Gate: at least one mandatory job did not succeed.');
      process.exit(1);
    }
    console.log('Gate: all mandatory jobs succeeded.');
  } catch (error) {
    console.error(`Gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
