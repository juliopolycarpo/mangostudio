// Canary's view of runtime reuse (stage 4 of #2698). A main CI run that skipped
// cargo for a platform because it reused an earlier run's unstamped runtime must
// be explainable, and the explanation verifiable, before Canary publishes from it.
//
// A job that reused a base runs the step `Use reused runtime base`, which
// cannot fail for a reason of its own, and uploads a record artifact whose name
// carries platform, producing run, input digest and binary SHA-256
// (runtimeReuseArtifactName). The jobs API reports the step's conclusion and the
// artifact listing reports the name; both are readable with `actions: read`,
// which is all Canary holds. Check-run annotations are not (they need
// `checks: read`).
//
// The rule, per platform of the source run:
//   - step succeeded, record present exactly once  => the claim is verified
//     against the Actions API, or the source is refused;
//   - step absent or skipped, no record            => built from source;
//   - anything else (a record without the step, a record with a malformed
//     name, two records, a failed marker, an unreadable job)  => refused.
// Nothing here compiles the claim's digest again: the producer check (a
// successful attempt-1 main push build job of this repository, whose commit is
// an ancestor of the source with no runtime input path changed since) is the
// independent proof that the producer's inputs are the source's.
import {
  parseRuntimeReuseArtifactName,
  type RuntimeBaseApi,
  verifyProducerRun,
} from './runtime-base-reuse';
import { invalidValue, requireJsonRecord, requirePositiveSafeInteger } from './script-guards';

/** Name of the step only a reusing job runs. runtime-build.yml's policy test pins it. */
export const RUNTIME_REUSE_MARKER_STEP = 'Use reused runtime base';

/** Prefix of every reuse record artifact; one that does not parse is a refusal, never ignored. */
const RECORD_PREFIX = 'runtime-reuse-';

/** The record is created while its job runs; the runner clock and GitHub's differ by less than this. */
const RECORD_CLOCK_SKEW_MS = 30_000;

/** One platform's reuse, as Canary verified it. */
interface ReusedRuntimeReceipt {
  readonly platform: string;
  /** Input digest the producer and this run share. */
  readonly digest: string;
  /** SHA-256 of the unstamped binary, as the reusing job verified it. */
  readonly binarySha256: string;
  readonly producerRunId: number;
  readonly producerSha: string;
  readonly recordArtifactId: number;
}

/** Which runtimes the source run compiled and which it took from an earlier run. */
export interface RuntimeReuseReceipt {
  readonly reused: readonly ReusedRuntimeReceipt[];
  /** Platforms whose cargo build ran in the source run. */
  readonly built: readonly string[];
}

/** A runtime build job of the source run, already found and checked successful. */
interface RuntimeJobRecord {
  readonly platform: string;
  readonly job: Record<string, unknown>;
}

function timestampMs(value: unknown, label: string): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) throw invalidValue(label, 'an ISO timestamp', value);
  return parsed;
}

/** The conclusion of the job's one step named `name`, or null when it has none. */
function stepConclusion(
  job: Record<string, unknown>,
  platform: string,
  name: string
): string | null {
  const label = `runtime ${platform} job ${String(job.id)} steps`;
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    throw invalidValue(label, 'a non-empty array of steps', job.steps);
  }
  const matching = job.steps
    .map((step, index) => requireJsonRecord(step, `${label}[${index}]`))
    .filter((step) => step.name === name);
  if (matching.length > 1)
    throw invalidValue(`${label} named ${name}`, 'at most one', matching.length);
  const [step] = matching;
  if (!step) return null;
  if (typeof step.conclusion !== 'string') {
    throw invalidValue(`${label} ${name} conclusion`, 'a string', step.conclusion);
  }
  return step.conclusion;
}

/**
 * Settle every runtime job of a qualified CI run as reused or built, verifying
 * each reuse claim. Throws, naming the platform, the value and the expected
 * shape, when any claim cannot be proved; the caller rejects the source.
 *
 * @example
 * settleRuntimeReuse(api, { repository, runId, sourceSha }, runtimeJobs);
 * // → { reused: [{ platform: 'linux-x64', digest: '…', producerRunId: 46128211509, … }], built: ['darwin-arm64', …] }
 */
export function settleRuntimeReuse(
  api: RuntimeBaseApi,
  source: { readonly repository: string; readonly runId: number; readonly sourceSha: string },
  runtimeJobs: readonly RuntimeJobRecord[]
): RuntimeReuseReceipt {
  const artifacts = api
    .list(
      `repos/${source.repository}/actions/runs/${source.runId}/artifacts?per_page=100`,
      'artifacts'
    )
    .map((artifact, index) => requireJsonRecord(artifact, `run ${source.runId} artifact ${index}`));
  const records = artifacts
    .filter(
      (artifact) => typeof artifact.name === 'string' && artifact.name.startsWith(RECORD_PREFIX)
    )
    .map((artifact) => {
      const name = String(artifact.name);
      const parsed = parseRuntimeReuseArtifactName(name);
      if (!parsed) {
        throw invalidValue(
          `run ${source.runId} artifact ${name}`,
          'runtime-reuse-<platform>-<producer run>-<digest>-<binary sha256>',
          name
        );
      }
      return { artifact, parsed };
    });
  // A record for a platform the run has no runtime job for is as unexplained as one without a marker.
  for (const { parsed } of records) {
    if (!runtimeJobs.some((entry) => entry.platform === parsed.platform)) {
      throw invalidValue(
        'reuse record platform',
        'the platform of a runtime job of the run',
        parsed.platform
      );
    }
  }

  const reused: ReusedRuntimeReceipt[] = [];
  const built: string[] = [];
  for (const { platform, job } of runtimeJobs) {
    const marker = stepConclusion(job, platform, RUNTIME_REUSE_MARKER_STEP);
    // `job` is the platform's job of the latest attempt, and the record names differ by
    // producer, so a re-run that picked another producer leaves the earlier attempt's
    // record beside its own. A record counts for this job only when it was created
    // while this job ran; the earlier attempt's record falls outside the window and is
    // not this job's claim. (Same producer, same name: `overwrite` replaces it.)
    const startedAt = timestampMs(job.started_at, `runtime ${platform} job started_at`);
    const completedAt = timestampMs(job.completed_at, `runtime ${platform} job completed_at`);
    const mine = records.filter((record) => {
      if (record.parsed.platform !== platform) return false;
      const createdAt = timestampMs(
        record.artifact.created_at,
        `runtime ${platform} reuse record ${String(record.artifact.name)} created_at`
      );
      return (
        createdAt >= startedAt - RECORD_CLOCK_SKEW_MS &&
        createdAt <= completedAt + RECORD_CLOCK_SKEW_MS
      );
    });
    if (marker === null || marker === 'skipped') {
      if (mine.length > 0) {
        throw invalidValue(
          `runtime ${platform} reuse record`,
          `none, because the "${RUNTIME_REUSE_MARKER_STEP}" step did not run`,
          mine.map((record) => record.artifact.name)
        );
      }
      built.push(platform);
      continue;
    }
    if (marker !== 'success') {
      throw invalidValue(
        `runtime ${platform} "${RUNTIME_REUSE_MARKER_STEP}" step conclusion`,
        'success or skipped',
        marker
      );
    }
    const [record] = mine;
    if (mine.length !== 1 || !record) {
      throw invalidValue(
        `runtime ${platform} reuse records of run ${source.runId}`,
        'exactly one, because the job reused a base',
        mine.length
      );
    }
    const label = `runtime ${platform} reuse record ${String(record.artifact.name)}`;
    if (record.artifact.expired !== false) {
      throw invalidValue(`${label} expired`, 'false', record.artifact.expired);
    }
    const origin = requireJsonRecord(record.artifact.workflow_run, `${label} workflow_run`);
    if (origin.id !== source.runId) {
      throw invalidValue(`${label} workflow_run.id`, String(source.runId), origin.id);
    }
    // The producer a record names must itself be a successful main push build job of this
    // repository whose inputs match the source's; the run record is read fresh from the API.
    const producer = verifyProducerRun(
      api,
      {
        repository: source.repository,
        platform,
        sourceSha: source.sourceSha,
        excludeRunId: source.runId,
      },
      record.parsed.producerRunId
    );
    if (producer.runId !== record.parsed.producerRunId) {
      throw invalidValue(
        `${label} producer run`,
        String(record.parsed.producerRunId),
        producer.runId
      );
    }
    reused.push({
      platform,
      digest: record.parsed.digest,
      binarySha256: record.parsed.binarySha256,
      producerRunId: producer.runId,
      producerSha: producer.sha,
      recordArtifactId: requirePositiveSafeInteger(record.artifact.id, `${label} id`),
    });
  }
  return { reused, built };
}
