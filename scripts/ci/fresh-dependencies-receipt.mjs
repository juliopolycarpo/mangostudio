// Terminal receipt for the advisory fresh-dependency workflow: which source,
// compiler and resolved lock a run judged, and how each stage ended, so a red
// run can be told apart (resolution failed, policy failed, platform checks
// failed) without reading logs, and the lock it judged can be re-fetched by hash.
//
// Pure functions plus a small CLI; Node built-ins only, so the workflow runs it
// from a checkout without `bun install`. The same classification feeds the
// compatibility issue report, so the two can never name different stages.
// Usage: NEEDS='<toJSON(needs)>' SOURCE_SHA=… REF=… EVENT=… RUN_URL=… bun ./scripts/ci/fresh-dependencies-receipt.mjs <receipt.json>

import { appendFileSync, writeFileSync } from 'node:fs';

const LOCK_ARTIFACT = 'fresh-rust-lockfile';
const JOBS = ['resolve', 'policy', 'fresh'];
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

function job(needs, name) {
  const entry = needs?.[name];
  if (!entry || typeof entry.result !== 'string') {
    throw new Error(
      `needs.${name} is missing; expected the toJSON(needs) object with resolve, policy and fresh`
    );
  }
  return { result: entry.result, outputs: entry.outputs ?? {} };
}

/**
 * Names the stage a run ended in from the `needs` context of a job that depends
 * on resolve, policy and fresh. A resolution failure is decided by the
 * resolver's own `generation` output, so a lock that was produced but could not
 * be uploaded is not mistaken for a failed resolution.
 *
 * @example
 * classifyFreshRun({
 *   resolve: { result: 'success', outputs: { generation: 'success' } },
 *   policy: { result: 'failure' },
 *   fresh: { result: 'success' },
 * }); // 'policy-failed'
 */
export function classifyFreshRun(needs) {
  const resolve = job(needs, 'resolve');
  const policy = job(needs, 'policy').result;
  const fresh = job(needs, 'fresh').result;
  if (resolve.result !== 'success') {
    if (resolve.outputs.generation === 'success') return 'lock-not-retained';
    return resolve.result === 'failure' ? 'resolution-failed' : 'incomplete';
  }
  if (policy === 'success' && fresh === 'success') return 'passed';
  if (policy === 'failure' && fresh === 'failure') return 'policy-and-platform-checks-failed';
  if (policy === 'failure' && fresh === 'success') return 'policy-failed';
  if (fresh === 'failure' && policy === 'success') return 'platform-checks-failed';
  return 'incomplete';
}

function lockIdentity(resolve, retained) {
  const sha256 = resolve.outputs.lock_sha256 ?? '';
  if (sha256 !== '' && !SHA256.test(sha256)) {
    throw new Error(
      `Invalid lock SHA-256 ${JSON.stringify(sha256)}; expected 64 lowercase hex characters or empty`
    );
  }
  if (resolve.outputs.generation === 'success' && sha256 === '') {
    throw new Error(
      'resolve reported generation "success" without a lock SHA-256; expected 64 lowercase hex characters'
    );
  }
  if (sha256 === '') return { produced: false, retained: false, sha256: null, artifact: null };
  // A lock that was generated and hashed but never uploaded has no artifact to
  // point at; the hash stays so the graph can still be identified.
  if (retained === false) return { produced: true, retained: false, sha256, artifact: null };
  return { produced: true, retained: true, sha256, artifact: LOCK_ARTIFACT };
}

/**
 * Builds the machine-readable receipt of one run.
 *
 * @example
 * const receipt = buildReceipt({ needs, sourceSha, ref: 'refs/heads/main', event: 'schedule', runUrl });
 * receipt.lock.sha256; // the lock that was judged, or null when none was produced
 */
export function buildReceipt({ needs, sourceSha, ref, event, runUrl }) {
  if (!GIT_SHA.test(sourceSha ?? '')) {
    throw new Error(
      `Invalid source SHA ${JSON.stringify(sourceSha)}; expected a 40-character Git SHA`
    );
  }
  const resolve = job(needs, 'resolve');
  const outcome = classifyFreshRun(needs);
  return {
    schema: 1,
    outcome,
    source: { sha: sourceSha, ref, event },
    run: { url: runUrl },
    toolchain: {
      rustc: resolve.outputs.rustc ?? '',
      cargo: resolve.outputs.cargo ?? '',
    },
    lock: lockIdentity(resolve, outcome !== 'lock-not-retained'),
    jobs: Object.fromEntries(JOBS.map((name) => [name, job(needs, name).result])),
  };
}

/**
 * Renders a receipt as the Markdown step summary.
 *
 * @example
 * renderReceiptSummary(receipt); // '### Fresh Rust dependencies: policy-failed ...'
 */
export function renderReceiptSummary(receipt) {
  let lock = 'none produced';
  if (receipt.lock.produced) {
    lock = receipt.lock.retained
      ? `\`${receipt.lock.sha256}\` (artifact \`${receipt.lock.artifact}\`)`
      : `\`${receipt.lock.sha256}\` (not retained: the lock artifact upload failed)`;
  }
  return [
    `### Fresh Rust dependencies: ${receipt.outcome}`,
    '',
    `- Source: \`${receipt.source.sha}\` (${receipt.source.ref}, ${receipt.source.event})`,
    `- Compiler: ${receipt.toolchain.rustc || 'unknown'}; ${receipt.toolchain.cargo || 'unknown'}`,
    `- Resolved lock SHA-256: ${lock}`,
    '',
    '| Job | Result |',
    '| --- | --- |',
    ...Object.entries(receipt.jobs).map(([name, result]) => `| ${name} | ${result} |`),
    '',
    'The `fresh` result covers the Linux, macOS and Windows legs together.',
    '',
  ].join('\n');
}

function main() {
  const [receiptPath] = process.argv.slice(2);
  if (!receiptPath) {
    throw new Error(
      'Missing receipt path; expected: fresh-dependencies-receipt.mjs <receipt.json>'
    );
  }
  let needs;
  try {
    needs = JSON.parse(process.env.NEEDS ?? '');
  } catch {
    throw new Error(`NEEDS is not valid JSON: ${JSON.stringify(process.env.NEEDS)}`);
  }
  const receipt = buildReceipt({
    needs,
    sourceSha: process.env.SOURCE_SHA,
    ref: process.env.REF,
    event: process.env.EVENT,
    runUrl: process.env.RUN_URL,
  });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const summary = renderReceiptSummary(receipt);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

if (import.meta.main) main();
