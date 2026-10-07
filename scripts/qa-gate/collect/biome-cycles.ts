import type { RunResult } from './support';

const CYCLE_RULES = new Set(['lint/suspicious/noImportCycles', 'lint/nursery/noSelfImport']);
const MAX_OUTPUT_SHOWN = 300;

/** One error-level cyclic import location from Biome's JSON reporter. */
export interface CycleDiagnostic {
  readonly category: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

const invalid = (value: unknown, expected: string): never => {
  throw new Error(
    `Biome output ${JSON.stringify(value)?.slice(0, MAX_OUTPUT_SHOWN)}; expected ${expected}`
  );
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(value, 'a JSON object');
  }
  return value as Record<string, unknown>;
};

const count = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalid(value, `a nonnegative integer for ${field}`);
  }
  return value;
};

const positive = (value: unknown, field: string): number => {
  const result = count(value, field);
  return result > 0 ? result : invalid(value, `a positive integer for ${field}`);
};

const pathName = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return invalid(value, 'a nonempty file path');
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
};

function cycleDiagnostic(value: unknown): CycleDiagnostic {
  const diagnostic = object(value);
  if (typeof diagnostic.category !== 'string' || !CYCLE_RULES.has(diagnostic.category)) {
    return invalid(value, 'only import-cycle or self-import diagnostics');
  }
  if (diagnostic.severity !== 'error') return invalid(value, 'an error-level cycle diagnostic');
  const location = object(diagnostic.location);
  const start = object(location.start);
  return {
    category: diagnostic.category,
    path: pathName(location.path),
    line: positive(start.line, 'start.line'),
    column: positive(start.column, 'start.column'),
  };
}

/**
 * Accept a complete Biome JSON scan, rejecting skipped files, truncated or
 * unrelated diagnostics and process failures instead of reporting zero.
 * @example parseBiomeCycleReport(await runCapture(command));
 */
export function parseBiomeCycleReport(result: RunResult): CycleDiagnostic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return invalid(
      { ...result, stderr: result.stderr.slice(0, MAX_OUTPUT_SHOWN) },
      'a complete Biome JSON lint report'
    );
  }
  const report = object(parsed);
  if (report.command !== 'lint') return invalid(report.command, 'command "lint"');
  const summary = object(report.summary);
  const errors = count(summary.errors, 'errors');
  for (const field of ['warnings', 'skipped', 'diagnosticsNotPrinted']) {
    if (count(summary[field], field) !== 0) return invalid(summary, `zero ${field}`);
  }
  if (count(summary.unchanged, 'unchanged') === 0) {
    return invalid(summary, 'at least one checked file');
  }
  if (!Array.isArray(report.diagnostics)) return invalid(report.diagnostics, 'a diagnostics array');
  const diagnostics = report.diagnostics.map(cycleDiagnostic);
  if (errors !== diagnostics.length) return invalid(summary, 'one diagnostic for every error');
  if (result.exitCode !== (errors > 0 ? 1 : 0)) {
    return invalid(result, `exit ${errors > 0 ? 1 : 0} matching the complete lint report`);
  }
  return diagnostics;
}

const signature = ({ category, path, line, column }: CycleDiagnostic): string =>
  JSON.stringify([category, path, line, column]);

function witnessPaths(diagnostic: CycleDiagnostic, body: string): string[][] {
  if (diagnostic.category === 'lint/nursery/noSelfImport') return [[diagnostic.path]];
  const resolved = body.match(/^ {2}i This import resolves to (.+)\r?$/m)?.[1];
  const imports = [...body.matchAll(/^ {8}\.\.\. which imports (.+)\r?$/gm)].map((match) =>
    pathName(match[1].trim())
  );
  if (!resolved || !/^ {8}\.\.\. which is the file we're importing from\.\r?$/m.test(body)) {
    return invalid(body, 'a complete Biome cycle path');
  }
  if (imports.at(-1) !== diagnostic.path)
    return invalid(imports, `a path ending at ${diagnostic.path}`);
  // Biome can report a closed walk such as C -> A -> B -> A -> C.
  // Split the explicitly reported walk into AB and AC without rebuilding an
  // import graph or searching for paths Biome did not report.
  const stack: string[] = [];
  const positions = new Map<string, number>();
  const cycles: string[][] = [];
  for (const path of [diagnostic.path, pathName(resolved.trim()), ...imports]) {
    const repeated = positions.get(path);
    if (repeated === undefined) {
      positions.set(path, stack.length);
      stack.push(path);
      continue;
    }
    cycles.push(stack.slice(repeated));
    for (const removed of stack.splice(repeated + 1)) positions.delete(removed);
  }
  return cycles;
}

function cycleKey(cycle: readonly string[]): string {
  const first = cycle.indexOf([...cycle].sort()[0]);
  return JSON.stringify([...cycle.slice(first), ...cycle.slice(0, first)]);
}

/**
 * Count distinct closed paths reported by Biome, deduplicating cycle rotations.
 * JSON locations must match every text diagnostic. Biome chooses cycle
 * witnesses, so overlapping graphs need not have madge's old DFS count.
 * @example countBiomeCycleWitnesses(jsonDiagnostics, await runCapture(textCommand));
 */
export function countBiomeCycleWitnesses(
  expected: readonly CycleDiagnostic[],
  result: RunResult
): number {
  const errors = result.stdout.match(/Found (\d+) errors?\./)?.[1];
  if (result.exitCode !== 1 || Number(errors) !== expected.length) {
    return invalid(result, `exit 1 and ${expected.length} complete text diagnostics`);
  }
  const headers = [...result.stderr.matchAll(/^(.+):(\d+):(\d+)\s+(\S+)[^\r\n]*$/gm)];
  const remaining = new Set(expected.map(signature));
  if (headers.length !== expected.length || remaining.size !== expected.length) {
    return invalid(result.stderr, `exactly ${expected.length} distinct diagnostic locations`);
  }
  const cycles = new Set<string>();
  for (const [index, header] of headers.entries()) {
    const diagnostic = {
      path: pathName(header[1]),
      line: Number(header[2]),
      column: Number(header[3]),
      category: header[4],
    };
    if (!remaining.delete(signature(diagnostic))) {
      return invalid(diagnostic, 'a location and rule matching the Biome JSON report');
    }
    const body = result.stderr.slice(
      (header.index ?? 0) + header[0].length,
      headers[index + 1]?.index
    );
    for (const cycle of witnessPaths(diagnostic, body)) cycles.add(cycleKey(cycle));
  }
  return cycles.size;
}
