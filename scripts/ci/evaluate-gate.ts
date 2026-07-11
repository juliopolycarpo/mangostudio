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
// This file must stay dependency-free (Node built-ins only): the gate jobs
// run it straight from a checkout without `bun install`.
// Usage: NEEDS='{"test":{"result":"success"}}' ALLOWED_SKIPS='qa-metrics' bun ./scripts/ci/evaluate-gate.ts

const NEED_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const;

export type NeedResult = (typeof NEED_RESULTS)[number];

export interface GateVerdict {
  readonly ok: boolean;
  readonly lines: readonly string[];
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
  allowedSkips: ReadonlySet<string>
): GateVerdict {
  const jobs = Object.keys(results);
  if (jobs.length === 0) {
    return {
      ok: false,
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

  return { ok, lines };
}

if (import.meta.main) {
  try {
    const verdict = evaluateGate(
      parseNeeds(process.env.NEEDS),
      parseAllowedSkips(process.env.ALLOWED_SKIPS)
    );
    for (const line of verdict.lines) console.log(line);
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
