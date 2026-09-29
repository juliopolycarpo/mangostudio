// The decision layer of the Rust coverage adapter: what the collector reports
// before it reads any data, driven through `rustCoverageInputs` with a named
// in-memory file fake.

import { describe, expect, it } from 'bun:test';

import { fakeFiles } from '../testing/junit-fixture';
import { expectState } from '../testing/measurement-assertions';
import {
  exportJson,
  RUST_SHA,
  receiptJson,
  TWO_CRATE_FILES,
  TWO_CRATE_ROOTS,
} from '../testing/rust-coverage-fixture';
import { EXPORT_FILE, RECEIPT_FILE, rustCoverageInputs } from './inputs';

const DIR = 'qa-rust-coverage';
const HEALTHY = {
  [`${DIR}/${EXPORT_FILE}`]: exportJson(TWO_CRATE_FILES),
  [`${DIR}/${RECEIPT_FILE}`]: receiptJson(RUST_SHA, 0),
};

const inputs = (
  source: { dir: string | null; relevant?: string; result?: string },
  files: Record<string, string> = HEALTHY
) =>
  rustCoverageInputs(
    { dir: source.dir, relevant: source.relevant, result: source.result },
    RUST_SHA,
    TWO_CRATE_ROOTS,
    fakeFiles(files).readText
  );

describe('rustCoverageInputs', () => {
  it('measures the crates from a delivered artifact', async () => {
    const coverage = await inputs({ dir: DIR, relevant: 'true', result: 'success' });

    expectState(coverage('crates/alpha'), 'measured');
    expectState(coverage('crates/beta'), 'measured');
  });

  describe('when the rust lane was proven irrelevant', () => {
    it('is unsupported with the reason, not unavailable, so the change is not called incomplete', async () => {
      const coverage = await inputs({ dir: null, relevant: 'false', result: 'skipped' });

      const cell = expectState(coverage('crates/alpha'), 'unsupported');
      expect(cell.reasons[0]).toContain('no Rust-relevant path changed');
    });

    it('does not read an artifact it was told is not there to trust', async () => {
      const fs = fakeFiles(HEALTHY);
      const coverage = await rustCoverageInputs(
        { dir: DIR, relevant: 'false', result: 'skipped' },
        RUST_SHA,
        TWO_CRATE_ROOTS,
        fs.readText
      );

      expectState(coverage('crates/alpha'), 'unsupported');
      expect(fs.reads).toEqual([]);
    });
  });

  it('is unsupported in a local run, where no CI job exists to ask', async () => {
    const coverage = await inputs({ dir: null });

    expect(expectState(coverage('crates/alpha'), 'unsupported').reasons[0]).toContain(
      'only by the CI rust-coverage job'
    );
  });

  describe('when the job was due but delivered nothing', () => {
    it.each([
      ['failure', 'failed'],
      ['cancelled', 'canceled'],
      ['skipped', 'skipped'],
      ['success', 'missing'],
    ])('a job result of %s with no artifact is unavailable: producer %s', async (result, cause) => {
      const coverage = await inputs({ dir: null, relevant: 'true', result });

      expect(expectState(coverage('crates/alpha'), 'unavailable').reasons[0]).toContain(
        `producer ${cause}`
      );
    });

    it('names the producer that failed when the download left an empty directory', async () => {
      const coverage = await inputs({ dir: DIR, relevant: 'true', result: 'failure' }, {});

      expect(expectState(coverage('crates/alpha'), 'unavailable').reasons[0]).toContain(
        'producer failed'
      );
    });
  });

  it('turns an unreadable artifact into unavailable instead of throwing', async () => {
    const coverage = await rustCoverageInputs(
      { dir: DIR, relevant: 'true', result: 'success' },
      RUST_SHA,
      TWO_CRATE_ROOTS,
      () => Promise.reject(new Error('EACCES: llvm-cov.json'))
    );

    expect(expectState(coverage('crates/alpha'), 'unavailable').reasons[0]).toBe(
      'rust coverage artifact unreadable: EACCES: llvm-cov.json'
    );
  });

  it('keeps a failed test run with an uploaded artifact partial, not unavailable', async () => {
    const coverage = await inputs(
      { dir: DIR, relevant: 'true', result: 'failure' },
      { ...HEALTHY, [`${DIR}/${RECEIPT_FILE}`]: receiptJson(RUST_SHA, 101) }
    );

    expectState(coverage('crates/alpha'), 'partial');
  });
});
