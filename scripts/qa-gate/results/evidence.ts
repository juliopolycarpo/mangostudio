// Reads what each expected test job left behind: one JUnit report per lane and
// the process receipt (`shard-meta.json`, written by the watchdog even when the
// job hung). Reading is separate from judging (./fold.ts) so every failure mode
// — a lost report, a cut-off report, no receipt — is a value a test can build.

import { basename } from 'node:path';

import {
  parseShardReceipt,
  type ShardIdentity,
  type ShardReceipt,
  shardIdentityFromDirectory,
} from '../../lib/shard-receipt';
import type { TestLaneId } from '../../lib/test-lanes';
import { type JunitCounts, parseJunitXml } from '../junit-results';
import type { ExpectedJob } from './expected-jobs';

type ReportEvidence =
  | { readonly kind: 'missing' }
  | { readonly kind: 'read'; readonly parsed: JunitCounts };

export type ReceiptEvidence =
  | { readonly kind: 'missing'; readonly why: string }
  | ({ readonly kind: 'read'; readonly exitCode: number } & Partial<ShardReceipt>);

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
 * Validate process evidence with the same contract as the producer and merger.
 * // Usage: parseReceipt('{"shard":3,"exitCode":0,"durationSeconds":41}', 3) // { kind: 'read', exitCode: 0, ... }
 */
export const parseReceipt = (
  text: string | null,
  expectedShard?: ShardIdentity
): ReceiptEvidence => {
  const parsed = parseShardReceipt(text, { expectedShard });
  return parsed.kind === 'invalid'
    ? { kind: 'missing', why: parsed.why }
    : { kind: 'read', ...parsed.receipt };
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
    receipt:
      receipt ??
      parseReceipt(
        await readText(`${job.dir}/${RECEIPT_FILE}`),
        shardIdentityFromDirectory(basename(job.dir))
      ),
    reports,
  };
};
