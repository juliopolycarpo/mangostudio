import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { exportJson, RUST_SHA, receiptJson } from '../testing/rust-coverage-fixture';
import { parseLlvmCovExport, parseRustCoverageReceipt } from './llvm-cov-export';

const SAMPLE = join(import.meta.dir, '../testing/fixtures/llvm-cov-export.sample.json');

describe('parseLlvmCovExport', () => {
  it('reads a real cargo llvm-cov export, ignoring the dimensions it does not use', async () => {
    const parsed = parseLlvmCovExport(await Bun.file(SAMPLE).text());

    if ('error' in parsed) throw new Error(`expected a parsed export | received: ${parsed.error}`);
    const files = parsed.value.data[0]?.files ?? [];
    expect(files.map((file) => file.filename)).toEqual([
      '/work/mangostudio/crates/mango-protocol/src/catalog.rs',
      '/work/mangostudio/crates/mangostudio-launcher/src/main.rs',
    ]);
    expect(files[0]?.summary.lines.count).toBeGreaterThan(0);
  });

  it('names the invalid location of a document that is not an llvm-cov export', () => {
    const parsed = parseLlvmCovExport(JSON.stringify({ type: 'lcov', data: [] }));

    expect(parsed).toEqual({
      error: expect.stringContaining('llvm-cov export failed schema validation'),
    });
  });

  it('rejects text that is not JSON', () => {
    expect(parseLlvmCovExport('{"type": "llvm.cov')).toEqual({
      error: 'llvm-cov export is not valid JSON',
    });
  });

  it('rejects a negative count instead of reading it as coverage', () => {
    const negative = exportJson({ 'crates/a/src/lib.rs': { lines: [-1, 0] } });

    expect('error' in parseLlvmCovExport(negative)).toBe(true);
  });

  it('rejects an export with no data record', () => {
    const empty = JSON.stringify({ ...JSON.parse(exportJson({})), data: [] });

    expect('error' in parseLlvmCovExport(empty)).toBe(true);
  });
});

describe('parseRustCoverageReceipt', () => {
  it('reads the commit and the test exit code', () => {
    expect(parseRustCoverageReceipt(receiptJson(RUST_SHA, 101))).toEqual({
      value: { sourceSha: RUST_SHA, testsExitCode: 101 },
    });
  });

  it.each([
    ['not JSON', '{"sourceSha'],
    ['no exit code', JSON.stringify({ sourceSha: RUST_SHA })],
    ['a string exit code', JSON.stringify({ sourceSha: RUST_SHA, testsExitCode: '0' })],
    ['a short sha', JSON.stringify({ sourceSha: 'abc', testsExitCode: 0 })],
  ])('never reads a receipt with %s as a finished run', (_label, text) => {
    expect('error' in parseRustCoverageReceipt(text), `receipt ${text} should be rejected`).toBe(
      true
    );
  });
});
