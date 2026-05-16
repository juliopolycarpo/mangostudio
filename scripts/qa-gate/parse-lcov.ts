export interface CoverageBucket {
  readonly total: number;
  readonly covered: number;
  readonly pct: number;
}

export interface CoverageSummary {
  readonly lines: CoverageBucket;
  readonly functions: CoverageBucket;
  readonly statements: CoverageBucket | null;
  readonly branches: CoverageBucket | null;
}

const bucket = (total: number, covered: number): CoverageBucket => ({
  total,
  covered,
  pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
});

/**
 * Bun's `bun test --coverage --coverage-reporter=lcov` emits a subset of the
 * LCOV record types: `SF`, `DA`, `LF`, `LH`, `FNF`, `FNH`. It does NOT emit
 * `BRF`/`BRH` (branch totals), so `branches` is reported as `null` and the
 * renderer must display "n/a". `statements` is also `null` for the same
 * reason — Bun's v8-based coverage does not separate statements from lines.
 */
export const parseLcovSummary = async (lcovPath: string): Promise<CoverageSummary> => {
  const text = await Bun.file(lcovPath).text();

  let linesTotal = 0;
  let linesCovered = 0;
  let fnTotal = 0;
  let fnCovered = 0;
  let brTotal = 0;
  let brCovered = 0;
  let sawBranches = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('LF:')) linesTotal += Number(line.slice(3));
    else if (line.startsWith('LH:')) linesCovered += Number(line.slice(3));
    else if (line.startsWith('FNF:')) fnTotal += Number(line.slice(4));
    else if (line.startsWith('FNH:')) fnCovered += Number(line.slice(4));
    else if (line.startsWith('BRF:')) {
      brTotal += Number(line.slice(4));
      sawBranches = true;
    } else if (line.startsWith('BRH:')) {
      brCovered += Number(line.slice(4));
      sawBranches = true;
    }
  }

  return {
    lines: bucket(linesTotal, linesCovered),
    functions: bucket(fnTotal, fnCovered),
    statements: null,
    branches: sawBranches ? bucket(brTotal, brCovered) : null,
  };
};
