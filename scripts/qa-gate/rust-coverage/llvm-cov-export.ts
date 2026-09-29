// The slice of `cargo llvm-cov report --json --summary-only` the QA gate reads,
// validated as untrusted input. The report is `llvm-cov export` JSON (type
// `llvm.coverage.json.export`): one record per instrumented source file with
// its line, function and region counts. Everything else in it (branches,
// instantiations, MC/DC, totals) is ignored, and unknown keys are allowed so a
// newer llvm-cov cannot make a healthy report unreadable.

import { describeSchemaError } from '@mangostudio/shared/errors';
import Type, { type Static, type TSchema } from 'typebox';
import Value from 'typebox/value';

const count = Type.Integer({ minimum: 0 });
const CountsSchema = Type.Object({ count, covered: count });

const FileRecordSchema = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: 1000 }),
  summary: Type.Object({
    lines: CountsSchema,
    functions: CountsSchema,
    regions: CountsSchema,
  }),
});

const LlvmCovExportSchema = Type.Object({
  type: Type.Literal('llvm.coverage.json.export'),
  cargo_llvm_cov: Type.Object({
    version: Type.String({ maxLength: 64 }),
    /** Absolute path of the workspace `Cargo.toml` the run measured; its directory is the file root. */
    manifest_path: Type.String({ minLength: 1, maxLength: 1000 }),
  }),
  data: Type.Array(Type.Object({ files: Type.Array(FileRecordSchema, { maxItems: 50_000 }) }), {
    minItems: 1,
    maxItems: 1,
  }),
});

export type LlvmCovExport = Static<typeof LlvmCovExportSchema>;

/** What the CI job records next to the export: which commit it measured and how the tests ended. */
const RustCoverageReceiptSchema = Type.Object({
  sourceSha: Type.String({ pattern: '^[0-9a-f]{40}$' }),
  /** Exit code of the instrumented `cargo llvm-cov` test run. */
  testsExitCode: Type.Integer(),
});

export type RustCoverageReceipt = Static<typeof RustCoverageReceiptSchema>;

type Parsed<T> = { readonly value: T } | { readonly error: string };

const parseJson = <S extends TSchema>(what: string, schema: S, text: string): Parsed<Static<S>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${what} is not valid JSON` };
  }
  if (Value.Check(schema, parsed)) return { value: parsed as Static<S> };
  const reason = describeSchemaError(Value.Errors(schema, parsed), 'unknown schema violation');
  return { error: `${what} failed schema validation (${reason})` };
};

/**
 * Parse `llvm-cov.json`; the error names the invalid location.
 * // Usage: const parsed = parseLlvmCovExport(await Bun.file('llvm-cov.json').text());
 */
export const parseLlvmCovExport = (text: string): Parsed<LlvmCovExport> =>
  parseJson('llvm-cov export', LlvmCovExportSchema, text);

/**
 * Parse `receipt.json`.
 * // Usage: parseRustCoverageReceipt('{"sourceSha":"<40 hex>","testsExitCode":0}')
 */
export const parseRustCoverageReceipt = (text: string): Parsed<RustCoverageReceipt> =>
  parseJson('rust coverage receipt', RustCoverageReceiptSchema, text);
