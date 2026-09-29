// Failure modes of the Rust coverage adapter, driven through the same entry
// point the collector uses (`resolveRustCoverage`). Each mode must land on
// `partial`, `stale` or `unavailable` for the crate it affects, never on a zero
// or on a complete measurement.

import { describe, expect, it } from 'bun:test';

import { measuredValue, presentValue } from '../model/states';
import { expectState } from '../testing/measurement-assertions';
import {
  exportJson,
  RUST_ROOT,
  RUST_SHA,
  receiptJson,
  TWO_CRATE_FILES,
  TWO_CRATE_ROOTS,
} from '../testing/rust-coverage-fixture';
import { resolveRustCoverage } from './resolve';

const resolve = (files: Parameters<typeof exportJson>[0] = TWO_CRATE_FILES, exitCode = 0) =>
  resolveRustCoverage(
    { export: exportJson(files), receipt: receiptJson(RUST_SHA, exitCode) },
    RUST_SHA,
    TWO_CRATE_ROOTS
  );

describe('resolveRustCoverage', () => {
  it('sums each crate from its own files: lines, functions and regions', () => {
    const coverage = resolve();

    const alpha = expectState(coverage('crates/alpha'), 'measured').value;
    expect(alpha.lines).toEqual({ total: 20, covered: 13, pct: 65 });
    expect(alpha.functions).toEqual({ total: 5, covered: 3, pct: 60 });
    expect(alpha.regions).toEqual({ total: 10, covered: 5, pct: 50 });
    const beta = expectState(coverage('crates/beta'), 'measured').value;
    expect(beta.lines).toEqual({ total: 50, covered: 30, pct: 60 });
  });

  it('names statements and branches as not collected instead of inventing them', () => {
    const summary = measuredValue(resolve()('crates/alpha'));

    expect(summary?.statements).toBeNull();
    expect(summary?.branches).toBeNull();
  });

  it('changes only the crate whose code changed', () => {
    const before = resolve();
    const after = resolve({
      ...TWO_CRATE_FILES,
      // Injected uncovered code: 30 more instrumented lines, none executed.
      'crates/alpha/src/injected.rs': { lines: [30, 0], functions: [3, 0], regions: [9, 0] },
    });

    expect(after('crates/beta')).toEqual(before('crates/beta'));
    const alpha = expectState(after('crates/alpha'), 'measured').value;
    expect(alpha.lines).toEqual({ total: 50, covered: 13, pct: 26 });
    expect(alpha.lines.pct).toBeLessThan(measuredValue(before('crates/alpha'))?.lines.pct ?? 0);
  });

  it('attributes a nested crate root once, to the deeper crate', () => {
    const coverage = resolveRustCoverage(
      {
        export: exportJson({
          'crates/alpha/src/lib.rs': { lines: [10, 10] },
          'crates/alpha/inner/src/lib.rs': { lines: [4, 1] },
        }),
        receipt: receiptJson(RUST_SHA, 0),
      },
      RUST_SHA,
      ['crates/alpha', 'crates/alpha/inner']
    );

    expect(measuredValue(coverage('crates/alpha'))?.lines.total).toBe(10);
    expect(measuredValue(coverage('crates/alpha/inner'))?.lines.total).toBe(4);
  });

  it('counts the files of every data bundle, not only the first', () => {
    const whole = JSON.parse(exportJson(TWO_CRATE_FILES));
    const [first, ...rest] = whole.data[0].files;
    const split = { ...whole, data: [{ files: [first] }, { files: rest }] };

    const coverage = resolveRustCoverage(
      { export: JSON.stringify(split), receipt: receiptJson(RUST_SHA, 0) },
      RUST_SHA,
      TWO_CRATE_ROOTS
    );

    expect(
      measuredValue(coverage('crates/alpha'))?.lines.total,
      'alpha instrumented lines summed over both data bundles'
    ).toBe(20);
    expect(
      measuredValue(coverage('crates/beta'))?.lines.total,
      'beta instrumented lines summed over both data bundles'
    ).toBe(50);
  });

  describe('a path repeated across data bundles', () => {
    const withDuplicate = (exitCode = 0) => {
      const whole = JSON.parse(exportJson(TWO_CRATE_FILES));
      const files = whole.data[0].files;
      // The same alpha file again in a second bundle, with different counts.
      const repeated = {
        ...files[0],
        summary: { ...files[0].summary, lines: { count: 99, covered: 1 } },
      };
      const doubled = { ...whole, data: [{ files }, { files: [repeated] }] };
      return resolveRustCoverage(
        { export: JSON.stringify(doubled), receipt: receiptJson(RUST_SHA, exitCode) },
        RUST_SHA,
        TWO_CRATE_ROOTS
      );
    };

    it('makes the owning crate partial, naming the file, instead of overwriting or summing', () => {
      const cell = expectState(withDuplicate()('crates/alpha'), 'partial');

      expect(cell.reasons[0]).toContain('crates/alpha/src/lib.rs appears more than once');
      // The first record is kept: neither the overwrite (99) nor a sum (109).
      expect(cell.value.lines.total).toBe(20);
    });

    it('leaves every other crate measured', () => {
      expectState(withDuplicate()('crates/beta'), 'measured');
    });

    it('keeps the test-exit reason next to the duplicate reason', () => {
      const cell = expectState(withDuplicate(101)('crates/alpha'), 'partial');

      expect(cell.reasons).toHaveLength(2);
      expect(cell.reasons.join('\n')).toContain('exited 101');
    });
  });

  it('ignores files outside the measured checkout, such as registry sources', () => {
    const coverage = resolve({
      ...TWO_CRATE_FILES,
      '/home/runner/.cargo/registry/src/x/serde/src/lib.rs': { lines: [999, 0] },
    });

    expect(measuredValue(coverage('crates/alpha'))?.lines.total).toBe(20);
  });

  describe('a crate without profile data', () => {
    it('is unavailable, not 0/0, when the export has no file of it', () => {
      const coverage = resolve({ 'crates/alpha/src/lib.rs': { lines: [10, 8] } });

      const beta = expectState(coverage('crates/beta'), 'unavailable');
      expect(beta.reasons[0]).toContain('crates/beta: no instrumented source file');
      expect(presentValue(coverage('crates/beta'))).toBeNull();
      expectState(coverage('crates/alpha'), 'measured');
    });

    it('is unavailable, not 0%, when none of its instrumented lines ran', () => {
      const coverage = resolve({
        ...TWO_CRATE_FILES,
        'crates/beta/src/lib.rs': { lines: [40, 0] },
        'crates/beta/src/more.rs': { lines: [10, 0] },
      });

      const beta = expectState(coverage('crates/beta'), 'unavailable');
      expect(beta.reasons[0]).toContain('0 of 50 instrumented lines were executed');
      expectState(coverage('crates/alpha'), 'measured');
    });

    it('is unavailable when its files carry no instrumented line at all', () => {
      const coverage = resolve({ 'crates/alpha/src/lib.rs': { lines: [0, 0] } });

      expect(expectState(coverage('crates/alpha'), 'unavailable').reasons[0]).toContain(
        '0 instrumented lines'
      );
    });

    it('is unavailable when a bucket claims more covered than total', () => {
      const coverage = resolve({ 'crates/alpha/src/lib.rs': { lines: [4, 9] } });

      expect(expectState(coverage('crates/alpha'), 'unavailable').reasons[0]).toContain(
        'lines covered=9 total=4 is inconsistent'
      );
    });
  });

  describe('a run that did not finish cleanly', () => {
    it('is partial, carrying the lower bound, when the tests exited non-zero', () => {
      const cell = expectState(resolve(TWO_CRATE_FILES, 101)('crates/alpha'), 'partial');

      expect(cell.value.lines.pct).toBe(65);
      expect(cell.reasons[0]).toContain('exited 101');
    });

    it('keeps an already-unavailable crate unavailable rather than partial', () => {
      const coverage = resolve({ 'crates/alpha/src/lib.rs': { lines: [10, 8] } }, 1);

      expectState(coverage('crates/beta'), 'unavailable');
      expectState(coverage('crates/alpha'), 'partial');
    });
  });

  describe('missing or unusable files', () => {
    const everyCrate = (coverage: ReturnType<typeof resolve>) =>
      TWO_CRATE_ROOTS.map((root) => coverage(root));

    it.each(['missing', 'failed', 'canceled', 'skipped'] as const)(
      'makes every crate unavailable when the producer %s and left no export',
      (cause) => {
        const coverage = resolveRustCoverage(
          { export: null, receipt: null },
          RUST_SHA,
          TWO_CRATE_ROOTS,
          cause
        );

        for (const cell of everyCrate(coverage)) {
          expect(expectState(cell, 'unavailable').reasons[0]).toContain(`producer ${cause}`);
        }
      }
    );

    it('makes every crate unavailable when the receipt is missing, since a finished run cannot be proven', () => {
      const coverage = resolveRustCoverage(
        { export: exportJson(TWO_CRATE_FILES), receipt: null },
        RUST_SHA,
        TWO_CRATE_ROOTS
      );

      for (const cell of everyCrate(coverage)) {
        expect(expectState(cell, 'unavailable').reasons[0]).toContain('receipt not delivered');
      }
    });

    it('makes every crate unavailable when the export is truncated', () => {
      const truncated = exportJson(TWO_CRATE_FILES).slice(0, 200);
      const coverage = resolveRustCoverage(
        { export: truncated, receipt: receiptJson(RUST_SHA, 0) },
        RUST_SHA,
        TWO_CRATE_ROOTS
      );

      for (const cell of everyCrate(coverage)) {
        expect(expectState(cell, 'unavailable').reasons[0]).toBe(
          'llvm-cov export is not valid JSON'
        );
      }
    });

    it('makes every crate stale when the receipt names another commit', () => {
      const coverage = resolveRustCoverage(
        { export: exportJson(TWO_CRATE_FILES), receipt: receiptJson('d'.repeat(40), 0) },
        RUST_SHA,
        TWO_CRATE_ROOTS
      );

      for (const cell of everyCrate(coverage)) {
        expect(expectState(cell, 'stale').reasons[0]).toContain(`envelope measures ${RUST_SHA}`);
      }
    });

    it('reads a file path outside the manifest directory as not part of the checkout', () => {
      const coverage = resolveRustCoverage(
        {
          export: exportJson(
            { 'crates/alpha/src/lib.rs': { lines: [10, 8] } },
            `${RUST_ROOT}/nested/Cargo.toml`
          ),
          receipt: receiptJson(RUST_SHA, 0),
        },
        RUST_SHA,
        TWO_CRATE_ROOTS
      );

      // `${RUST_ROOT}/crates/alpha/...` is not under `${RUST_ROOT}/nested`.
      expectState(coverage('crates/alpha'), 'unavailable');
    });
  });
});
