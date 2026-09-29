import { describe, expect, it } from 'bun:test';

import { PRODUCER_NAME, readProvenance, resolveSourceSha } from './provenance';

const MERGE_SHA = 'd'.repeat(40);
const CHECKOUT_SHA = 'e'.repeat(40);

const ACTIONS_ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SHA: MERGE_SHA,
  GITHUB_RUN_ID: '9876543210',
  GITHUB_RUN_ATTEMPT: '2',
};

const options = { checkoutHead: CHECKOUT_SHA, producerVersion: '0.1.1' };

describe('resolveSourceSha', () => {
  it('prefers GITHUB_SHA (the merge commit on pull_request runs) over the checkout HEAD', () => {
    expect(resolveSourceSha({ GITHUB_SHA: MERGE_SHA }, CHECKOUT_SHA)).toBe(MERGE_SHA);
  });

  it('falls back to the checkout HEAD outside Actions', () => {
    expect(resolveSourceSha({}, CHECKOUT_SHA)).toBe(CHECKOUT_SHA);
    expect(resolveSourceSha({ GITHUB_SHA: '' }, CHECKOUT_SHA)).toBe(CHECKOUT_SHA);
  });

  it('rejects anything that is not a full SHA, naming the value', () => {
    expect(() => resolveSourceSha({}, 'unknown')).toThrow(
      'source sha "unknown" is not a 40-hex commit SHA'
    );
    expect(() => resolveSourceSha({ GITHUB_SHA: 'abc123' }, CHECKOUT_SHA)).toThrow('"abc123"');
  });
});

describe('readProvenance', () => {
  it('reads sha, run id and attempt from the Actions environment', () => {
    expect(readProvenance(ACTIONS_ENV, options)).toEqual({
      sourceSha: MERGE_SHA,
      producer: { name: PRODUCER_NAME, version: '0.1.1' },
      runId: 9876543210,
      runAttempt: 2,
    });
  });

  it.each([
    ['GITHUB_RUN_ID', undefined],
    ['GITHUB_RUN_ID', ''],
    ['GITHUB_RUN_ID', '0'],
    ['GITHUB_RUN_ID', '12a'],
    ['GITHUB_RUN_ID', '-4'],
    ['GITHUB_RUN_ATTEMPT', undefined],
    ['GITHUB_RUN_ATTEMPT', '1.5'],
  ])('inside Actions, rejects %s = %p instead of inventing provenance', (name, value) => {
    expect(() => readProvenance({ ...ACTIONS_ENV, [name]: value }, options)).toThrow(
      new RegExp(`${name} must be a positive integer; received`)
    );
  });

  it('gives a local run an explicit placeholder run identity', () => {
    const provenance = readProvenance({}, options);

    expect(provenance.runId).toBe(1);
    expect(provenance.runAttempt).toBe(1);
    expect(provenance.sourceSha).toBe(CHECKOUT_SHA);
  });

  it('still rejects a malformed run id outside Actions', () => {
    expect(() => readProvenance({ GITHUB_RUN_ID: 'abc' }, options)).toThrow(
      'GITHUB_RUN_ID must be a positive integer; received "abc"'
    );
  });
});
