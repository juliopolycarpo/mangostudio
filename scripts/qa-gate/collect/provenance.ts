// Envelope provenance from the GitHub Actions environment. Actions sets
// GITHUB_SHA, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT on every run, so the
// workflow needs no extra wiring. Inside Actions a missing value is an error
// (an envelope with invented provenance would look like a real baseline);
// outside Actions the run is local and gets an explicit local placeholder.

import type { Provenance } from '../model/envelope';

export const PRODUCER_NAME = 'mangostudio/qa-gate-collect';

export type Env = Readonly<Record<string, string | undefined>>;

const SHA_RE = /^[0-9a-f]{40}$/;

const nonEmpty = (env: Env, name: string): string | null => {
  const value = env[name];
  return value && value.length > 0 ? value : null;
};

/**
 * The commit that was actually measured: GITHUB_SHA (the merge commit on
 * pull_request runs), else the checkout's HEAD. Throws unless it is a full SHA.
 * // Usage: resolveSourceSha(process.env, getCommitSha())
 */
export const resolveSourceSha = (env: Env, checkoutHead: string): string => {
  const sha = nonEmpty(env, 'GITHUB_SHA') ?? checkoutHead;
  if (!SHA_RE.test(sha)) {
    throw new Error(
      `source sha ${JSON.stringify(sha)} is not a 40-hex commit SHA; set GITHUB_SHA or run inside a git checkout`
    );
  }
  return sha;
};

const positiveInt = (env: Env, name: string, localDefault: number | null): number => {
  const raw = nonEmpty(env, name);
  if (raw === null && localDefault !== null) return localDefault;
  const parsed = Number(raw);
  if (raw === null || !/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
  }
  return parsed;
};

/**
 * Provenance for the envelope being produced.
 * // Usage: readProvenance(process.env, { checkoutHead: getCommitSha(), producerVersion: '0.1.1' })
 */
export const readProvenance = (
  env: Env,
  options: { readonly checkoutHead: string; readonly producerVersion: string }
): Provenance => {
  const inActions = env.GITHUB_ACTIONS === 'true';
  const localDefault = inActions ? null : 1;
  return {
    sourceSha: resolveSourceSha(env, options.checkoutHead),
    producer: { name: PRODUCER_NAME, version: options.producerVersion },
    runId: positiveInt(env, 'GITHUB_RUN_ID', localDefault),
    runAttempt: positiveInt(env, 'GITHUB_RUN_ATTEMPT', localDefault),
  };
};
