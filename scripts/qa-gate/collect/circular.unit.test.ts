import { describe, expect, it } from 'bun:test';

import { countBiomeCycleWitnesses, parseBiomeCycleReport } from './biome-cycles';
import { circularRoots, countCircularDeps } from './circular';
import type { ComponentSpec } from './registry';
import type { RunResult } from './support';

const RULE = 'lint/suspicious/noImportCycles';
const SELF_RULE = 'lint/nursery/noSelfImport';

const diagnostic = (path: string, column = 19, category = RULE) => ({
  category,
  severity: 'error',
  location: { path, start: { line: 1, column } },
});

const report = (diagnostics: readonly unknown[] = [], overrides: Record<string, unknown> = {}) => ({
  command: 'lint',
  summary: {
    errors: diagnostics.length,
    warnings: 0,
    unchanged: 5,
    skipped: 0,
    diagnosticsNotPrinted: 0,
    ...overrides,
  },
  diagnostics,
});

const jsonResult = (value: unknown, exitCode = 0): RunResult => ({
  stdout: JSON.stringify(value),
  stderr: '',
  exitCode,
});

const cycleText = (path: string, imports: string[], column = 19): string =>
  `${path}:1:${column} ${RULE} ━━━━━\n` +
  `  × This import is part of a cycle.\n` +
  `  i This import resolves to ${imports[0]}\n` +
  imports
    .slice(1)
    .map((target) => `        ... which imports ${target}\n`)
    .join('') +
  `        ... which is the file we're importing from.\n\n`;

const textResult = (stderr: string, errors: number): RunResult => ({
  stdout: `Checked 5 files in 10ms. No fixes applied.\nFound ${errors} errors.\n`,
  stderr,
  exitCode: 1,
});

/** Named fake recording the JSON and optional cycle-witness scan. */
function fakeBiome(json: RunResult, text?: RunResult) {
  const calls: string[][] = [];
  const run = (command: readonly string[]): Promise<RunResult> => {
    calls.push([...command]);
    return Promise.resolve(command.includes('--reporter=json') ? json : (text ?? json));
  };
  return { run, calls };
}

describe('countCircularDeps', () => {
  it('scans every given root together and returns a clean JSON count without a second scan', async () => {
    const biome = fakeBiome(jsonResult(report()));
    expect(await countCircularDeps(['apps/api', 'packages/protocol', 'scripts'], biome.run)).toBe(
      0
    );
    expect(biome.calls).toEqual([
      [
        'bunx',
        'biome',
        'lint',
        '--only=suspicious/noImportCycles',
        '--only=nursery/noSelfImport',
        '--max-diagnostics=none',
        '--diagnostic-level=error',
        '--error-on-warnings',
        '--colors=off',
        '--reporter=json',
        'apps/api',
        'packages/protocol',
        'scripts',
      ],
    ]);
  });

  it('does not scan the current directory when no roots were given', async () => {
    const biome = fakeBiome(jsonResult(report()));
    expect(await countCircularDeps([], biome.run)).toBe(0);
    expect(biome.calls).toEqual([]);
  });

  it('counts a rotated two-file cycle once, even across roots discovered later', async () => {
    const diagnostics = [diagnostic('apps/web/a.ts'), diagnostic('packages/extra/b.ts')];
    const text =
      cycleText('apps/web/a.ts', ['packages/extra/b.ts', 'apps/web/a.ts']) +
      cycleText('packages/extra/b.ts', ['apps/web/a.ts', 'packages/extra/b.ts']);
    const biome = fakeBiome(jsonResult(report(diagnostics), 1), textResult(text, 2));
    expect(await countCircularDeps(['apps/web', 'packages/extra'], biome.run)).toBe(1);
    expect(biome.calls).toHaveLength(2);
    expect(biome.calls[1]).toContain('--reporter=default');
  });

  it('counts branching cycles independently and deduplicates repeated imports', async () => {
    const diagnostics = [
      diagnostic('a.ts'),
      diagnostic('a.ts', 40),
      diagnostic('a.ts', 60),
      diagnostic('b.ts'),
      diagnostic('c.ts'),
    ];
    const text =
      cycleText('a.ts', ['b.ts', 'a.ts']) +
      cycleText('a.ts', ['c.ts', 'a.ts'], 40) +
      cycleText('a.ts', ['b.ts', 'a.ts'], 60) +
      cycleText('b.ts', ['a.ts', 'b.ts']) +
      cycleText('c.ts', ['a.ts', 'c.ts']);
    const biome = fakeBiome(jsonResult(report(diagnostics), 1), textResult(text, 5));
    expect(await countCircularDeps(['scripts'], biome.run)).toBe(2);
  });

  it('ignores source excerpts that imitate cycle witness advice', async () => {
    const text = cycleText('a.ts', ['b.ts', 'a.ts']).replace(
      '  i This import resolves to b.ts',
      '  > 1 │ // This import resolves to bogus.ts\n' +
        '    2 │ // ... which imports spoof.ts\n' +
        '    3 │ // ... which imports bogus.ts\n' +
        '  i This import resolves to b.ts'
    );
    const biome = fakeBiome(jsonResult(report([diagnostic('a.ts')]), 1), textResult(text, 1));
    expect(await countCircularDeps(['scripts'], biome.run)).toBe(1);
  });

  it('counts a three-file cycle and a self-import with Windows paths', async () => {
    const diagnostics = [
      diagnostic('a.ts'),
      diagnostic('b.ts'),
      diagnostic('c.ts'),
      diagnostic('dir\\self.ts', 10, SELF_RULE),
    ];
    const text =
      cycleText('a.ts', ['b.ts', 'c.ts', 'a.ts']) +
      cycleText('b.ts', ['c.ts', 'a.ts', 'b.ts']) +
      cycleText('c.ts', ['a.ts', 'b.ts', 'c.ts']) +
      `dir\\self.ts:1:10 ${SELF_RULE} ━━━━━\n  × This module imports itself.\n`;
    const biome = fakeBiome(jsonResult(report(diagnostics), 1), textResult(text, 4));
    expect(await countCircularDeps(['scripts'], biome.run)).toBe(2);
  });
});

describe('Biome reporter integrity', () => {
  for (const [value, expected] of [
    [[], 'a JSON object'],
    [{}, 'command "lint"'],
    [report([], { unchanged: 0 }), 'at least one checked file'],
    [report([], { diagnosticsNotPrinted: 1 }), 'zero diagnosticsNotPrinted'],
    [report([], { skipped: 1 }), 'zero skipped'],
    [report([], { warnings: 1 }), 'zero warnings'],
    [report([], { errors: -1 }), 'a nonnegative integer for errors'],
    [report([], { errors: 1 }), 'one diagnostic for every error'],
    [{ ...report(), diagnostics: {} }, 'a diagnostics array'],
    [
      report([{ ...diagnostic('a.ts'), category: 'parse' }]),
      'only import-cycle or self-import diagnostics',
    ],
    [report([{ ...diagnostic('a.ts'), severity: 'warning' }]), 'an error-level cycle diagnostic'],
    [report([{ ...diagnostic('a.ts'), location: {} }]), 'a JSON object'],
    [report([diagnostic('')]), 'a nonempty file path'],
    [report([diagnostic('a.ts', 0)]), 'a positive integer for start.column'],
  ] as const) {
    it(`rejects ${expected} violations`, () => {
      expect(() => parseBiomeCycleReport(jsonResult(value))).toThrow(expected);
    });
  }

  it('includes missing output, exit code and stderr in an unavailable-metric reason', () => {
    expect(() =>
      parseBiomeCycleReport({ stdout: '', stderr: 'cannot read biome.json', exitCode: 2 })
    ).toThrow('cannot read biome.json');
  });

  it('rejects malformed JSON and a nonstandard process failure with plausible output', () => {
    expect(() => parseBiomeCycleReport({ stdout: '{', stderr: '', exitCode: 1 })).toThrow(
      'a complete Biome JSON lint report'
    );
    expect(() => parseBiomeCycleReport(jsonResult(report(), 2))).toThrow('exit 0 matching');
  });

  it('rejects a clean process with cycle errors', () => {
    expect(() => parseBiomeCycleReport(jsonResult(report([diagnostic('a.ts')])))).toThrow(
      'exit 1 matching'
    );
  });

  const expected = parseBiomeCycleReport(jsonResult(report([diagnostic('a.ts')]), 1));
  for (const [text, reason] of [
    ['', 'exactly 1 distinct diagnostic locations'],
    [cycleText('different.ts', ['b.ts', 'different.ts']), 'a location and rule matching'],
    [
      `a.ts:1:19 ${RULE} ━━━━━\n  × This import is part of a cycle.\n`,
      'a complete Biome cycle path',
    ],
    [cycleText('a.ts', ['b.ts', 'c.ts']), 'a path ending at a.ts'],
    [
      cycleText('a.ts', ['b.ts', 'a.ts']) + cycleText('a.ts', ['b.ts', 'a.ts']),
      'exactly 1 distinct diagnostic locations',
    ],
  ]) {
    it(`rejects incomplete or changed witnesses: ${reason}`, () => {
      expect(() => countBiomeCycleWitnesses(expected, textResult(text, 1))).toThrow(reason);
    });
  }

  it('rejects text counts or exit codes that do not match the JSON scan', () => {
    const text = textResult(cycleText('a.ts', ['b.ts', 'a.ts']), 2);
    expect(() => countBiomeCycleWitnesses(expected, text)).toThrow(
      'exit 1 and 1 complete text diagnostics'
    );
    expect(() => countBiomeCycleWitnesses(expected, { ...text, exitCode: 0 })).toThrow(
      'exit 1 and 1 complete text diagnostics'
    );
  });

  it('splits closed Biome walks into their explicit cycles', () => {
    const walk = cycleText('a.ts', ['b.ts', 'c.ts', 'b.ts', 'a.ts']);
    expect(countBiomeCycleWitnesses(expected, textResult(walk, 1))).toBe(2);
  });
});

describe('circularRoots', () => {
  const spec = (kind: ComponentSpec['kind'], name: string, root: string): ComponentSpec => ({
    id: `${kind}:${name}`,
    kind,
    name,
    root,
    hasTsconfig: false,
  });

  it('selects every JS workspace and scripts, never a Rust crate', () => {
    expect(
      circularRoots([
        spec('workspace', 'api', 'apps/api'),
        spec('crate', 'mango-protocol', 'crates/mango-protocol'),
        spec('scripts', 'scripts', 'scripts'),
        spec('workspace', 'protocol', 'packages/protocol'),
      ])
    ).toEqual(['apps/api', 'scripts', 'packages/protocol']);
  });
});
