// Reads what each expected test job left behind: one JUnit report per lane and
// the process receipt (`shard-meta.json`, written by the watchdog even when the
// job hung). Reading is separate from judging (./fold.ts) so every failure mode
// — a lost report, a cut-off report, no receipt — is a value a test can build.

import type { TestLaneId } from '../../lib/test-lanes';
import { type JunitCounts, parseJunitXml } from '../junit-results';
import type { ExpectedJob } from './expected-jobs';

type ReportEvidence =
  | { readonly kind: 'missing' }
  | { readonly kind: 'read'; readonly parsed: JunitCounts };

export type ReceiptEvidence =
  | { readonly kind: 'missing'; readonly why: string }
  | { readonly kind: 'read'; readonly exitCode: number; readonly attempts?: number };

/** Everything one job left behind. */
export interface JobEvidence {
  readonly job: ExpectedJob;
  readonly receipt: ReceiptEvidence;
  readonly reports: ReadonlyMap<TestLaneId, ReportEvidence>;
}

/** Reads a text file; null when it does not exist. Injectable so tests use a named fake. */
export type ReadText = (path: string) => Promise<string | null>;

const RECEIPT_FILE = 'shard-meta.json';

/** Default reader over the real filesystem. */
export const readTextOrNull: ReadText = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
};

/**
 * Validate a receipt's text. `readJson`-style casting is not enough: a
 * receipt that is valid JSON of the wrong shape must not read as a clean run.
 * // Usage: parseReceipt('{"shard":3,"exitCode":0,"durationSeconds":41}') // { kind: 'read', exitCode: 0 }
 */
export const parseReceipt = (text: string | null): ReceiptEvidence => {
  if (text === null) return { kind: 'missing', why: `no ${RECEIPT_FILE}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'missing', why: `${RECEIPT_FILE} is not valid JSON` };
  }
  const exitCode =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { exitCode?: unknown }).exitCode
      : undefined;
  if (typeof exitCode !== 'number' || !Number.isFinite(exitCode)) {
    return {
      kind: 'missing',
      why: `${RECEIPT_FILE} has no numeric exitCode (found ${JSON.stringify(exitCode)})`,
    };
  }
  const attempts = (parsed as { attempts?: unknown }).attempts;
  // Older receipts carry no count; anything but a positive integer is ignored
  // rather than trusted, so a bad value can only hide a retry, never invent one.
  return Number.isInteger(attempts) && (attempts as number) >= 1
    ? { kind: 'read', exitCode, attempts: attempts as number }
    : { kind: 'read', exitCode };
};

/**
 * Read one job's receipt and every lane report it was expected to carry.
 * `receipt` overrides the on-disk receipt for a run that has no per-job file
 * (a single-machine run, whose exit code the caller already holds).
 * // Usage: await readJobEvidence(job, readTextOrNull)
 */
export const readJobEvidence = async (
  job: ExpectedJob,
  readText: ReadText,
  receipt?: ReceiptEvidence
): Promise<JobEvidence> => {
  const reports = new Map<TestLaneId, ReportEvidence>();
  for (const lane of job.lanes) {
    const text = await readText(`${job.dir}/${lane.junitPath}`);
    reports.set(
      lane.id,
      text === null ? { kind: 'missing' } : { kind: 'read', parsed: parseJunitXml(text) }
    );
  }
  return {
    job,
    receipt: receipt ?? parseReceipt(await readText(`${job.dir}/${RECEIPT_FILE}`)),
    reports,
  };
};
