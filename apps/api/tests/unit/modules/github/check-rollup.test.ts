import { describe, expect, it } from 'bun:test';
import {
  summarizeCheckBuckets,
  summarizeCheckRollup,
  summarizeOptionalCheckRollup,
} from '../../../../src/modules/github/domain/check-rollup';

const checkRun = (status: string, conclusion?: string) => ({
  __typename: 'CheckRun',
  status,
  ...(conclusion === undefined ? {} : { conclusion }),
});

const statusContext = (state: string) => ({ __typename: 'StatusContext', context: 'bot', state });

describe('statusCheckRollup reducer', () => {
  it('counts a CheckRun by status first and conclusion second', () => {
    expect(
      summarizeCheckRollup([
        checkRun('QUEUED'),
        checkRun('IN_PROGRESS'),
        checkRun('COMPLETED', 'SUCCESS'),
        checkRun('COMPLETED', 'FAILURE'),
      ])
    ).toEqual({ passed: 1, failed: 1, pending: 2, total: 4 });
  });

  it('counts a StatusContext, which carries a state and no conclusion', () => {
    // The variant third-party bots report through. A reducer that only knew
    // CheckRun would report every one of these as no check at all, which shows
    // a fully green pull request as having no CI.
    expect(
      summarizeCheckRollup([
        statusContext('SUCCESS'),
        statusContext('FAILURE'),
        statusContext('ERROR'),
        statusContext('PENDING'),
        statusContext('EXPECTED'),
      ])
    ).toEqual({ passed: 1, failed: 2, pending: 2, total: 5 });
  });

  it('counts a mixed array of both variants', () => {
    expect(
      summarizeCheckRollup([
        checkRun('COMPLETED', 'SUCCESS'),
        statusContext('SUCCESS'),
        checkRun('IN_PROGRESS'),
        statusContext('FAILURE'),
        checkRun('COMPLETED', 'SKIPPED'),
      ])
    ).toEqual({ passed: 2, failed: 1, pending: 1, total: 5 });
  });

  it('carries total rather than deriving it, because some checks have no bucket', () => {
    // Skipped, neutral and cancelled are real entries in no bucket, so
    // passed + failed + pending is legitimately less than total.
    const summary = summarizeCheckRollup([
      checkRun('COMPLETED', 'SKIPPED'),
      checkRun('COMPLETED', 'NEUTRAL'),
      checkRun('COMPLETED', 'CANCELLED'),
      checkRun('COMPLETED', 'SUCCESS'),
    ]);
    expect(summary).toEqual({ passed: 1, failed: 0, pending: 0, total: 4 });
    expect(summary.passed + summary.failed + summary.pending).toBeLessThan(summary.total);
  });

  it('treats every failure spelling GitHub uses as failed', () => {
    expect(
      summarizeCheckRollup([
        checkRun('COMPLETED', 'FAILURE'),
        checkRun('COMPLETED', 'TIMED_OUT'),
        checkRun('COMPLETED', 'ACTION_REQUIRED'),
        checkRun('COMPLETED', 'STARTUP_FAILURE'),
      ])
    ).toEqual({ passed: 0, failed: 4, pending: 0, total: 4 });
  });

  it('counts an unrecognised entry toward total and no bucket', () => {
    expect(summarizeCheckRollup([{ __typename: 'SomethingNew' }])).toEqual({
      passed: 0,
      failed: 0,
      pending: 0,
      total: 1,
    });
  });

  it('keeps "no CI at all" distinct from "a rollup that came back empty"', () => {
    expect(summarizeOptionalCheckRollup(null)).toBeNull();
    expect(summarizeOptionalCheckRollup(undefined)).toBeNull();
    expect(summarizeOptionalCheckRollup([])).toEqual({
      passed: 0,
      failed: 0,
      pending: 0,
      total: 0,
    });
  });
});

describe('gh pr checks bucket reducer', () => {
  it('agrees with the rollup reducer on the same checks', () => {
    // gh derives `bucket` from the very rollup the other reducer counts, so the
    // list row and the checks drawer must report identical numbers. This is
    // what keeps that true as either side changes.
    const rollup = [
      checkRun('COMPLETED', 'SUCCESS'),
      statusContext('SUCCESS'),
      checkRun('IN_PROGRESS'),
      statusContext('FAILURE'),
      checkRun('COMPLETED', 'SKIPPED'),
      checkRun('COMPLETED', 'CANCELLED'),
    ];
    const buckets = [
      { bucket: 'pass' },
      { bucket: 'pass' },
      { bucket: 'pending' },
      { bucket: 'fail' },
      { bucket: 'skipping' },
      { bucket: 'cancel' },
    ];

    expect(summarizeCheckBuckets(buckets)).toEqual(summarizeCheckRollup(rollup));
  });

  it('counts skipping and cancel toward total only', () => {
    expect(summarizeCheckBuckets([{ bucket: 'skipping' }, { bucket: 'cancel' }])).toEqual({
      passed: 0,
      failed: 0,
      pending: 0,
      total: 2,
    });
  });
});
