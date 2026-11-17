import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  brotliSize,
  budgetSummary,
  budgetViolation,
  buildLoadGraphReport,
  bytesByOwner,
  chunkStats,
  eagerModules,
  LOAD_SCENARIOS,
  type LoadGraphMetafile,
  type LoadScenario,
  measureEagerAssets,
  measureEagerPayload,
  moduleOwner,
  parseBundleBudget,
  renderLoadGraphReport,
  resolveScenario,
} from '../ci/frontend-load-graph';

type Output = LoadGraphMetafile['outputs'][string];
type Input = LoadGraphMetafile['inputs'][string];

/**
 * A build shaped like the real one. `main` is the entry. `Lazy.tsx` is a
 * dynamic-import target that Bun split into a 75 B stub (`chunk-Lazy`) in front
 * of a shared chunk (`chunk-shared`), because a second chunk also uses it: the
 * two-hop shape. `chunk-deep` is a static import of `chunk-shared` that the
 * stub names too, so it is fetched in the same round as `chunk-shared`.
 */
function fixtureMetafile(): LoadGraphMetafile {
  const output = (
    bytes: number,
    inputs: Record<string, number>,
    imports: Output['imports'] = []
  ): Output => ({
    bytes,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([path, bytesInOutput]) => [path, { bytesInOutput }])
    ),
    imports,
  });
  const input = (imports: Input['imports'] = []): Input => ({ imports });
  return {
    inputs: {
      'src/main.tsx': input([
        { path: './chunk-Lazy-aaaaaaaa.js', kind: 'dynamic-import', entryPoint: 'src/Lazy.tsx' },
        { path: './chunk-tiny-dddddddd.js', kind: 'dynamic-import', entryPoint: 'src/Second.tsx' },
      ]),
      'src/Second.tsx': input(),
      'src/Eager.tsx': input(),
      'src/Lazy.tsx': input(),
      'src/Other.tsx': input(),
    },
    outputs: {
      './assets/main-mmmmmmmm.js': output(1000, {
        'src/main.tsx': 300,
        'src/Eager.tsx': 600,
        '../../node_modules/.bun/react@19.0.0/node_modules/react/index.js': 100,
      }),
      './assets/chunk-Lazy-aaaaaaaa.js': output(75, {}, [
        { path: './assets/chunk-shared-bbbbbbbb.js', kind: 'import-statement' },
        { path: './assets/chunk-deep-cccccccc.js', kind: 'import-statement' },
      ]),
      './assets/chunk-shared-bbbbbbbb.js': output(
        5000,
        { 'src/Lazy.tsx': 4000, 'src/Other.tsx': 1000 },
        [
          { path: './assets/chunk-deep-cccccccc.js', kind: 'import-statement' },
          { path: './assets/main-mmmmmmmm.js', kind: 'import-statement' },
        ]
      ),
      './assets/chunk-deep-cccccccc.js': output(300, {}),
      './assets/chunk-tiny-dddddddd.js': output(70, { 'src/Second.tsx': 70 }),
    },
  };
}

const EAGER = new Set(['index.html', 'assets/main-mmmmmmmm.js']);

describe('moduleOwner', () => {
  test.each([
    ['../../node_modules/.bun/react-dom@19.3.1+abc/node_modules/react-dom/cjs/x.js', 'react-dom'],
    [
      '../../node_modules/.bun/@tanstack+router-core@1.1.1/node_modules/@tanstack/router-core/dist/router.js',
      '@tanstack/router-core',
    ],
    ['../shared/src/i18n/en.ts', 'shared/i18n'],
    ['src/features/chat/Chat.tsx', 'src/features/chat'],
    ['src/components/ui/Button.tsx', 'src/components'],
    ['src/index.css', 'src/index.css'],
  ])('%s -> %s', (module, owner) => {
    expect(moduleOwner(module)).toBe(owner);
  });
});

describe('eager graph statistics', () => {
  test('eagerModules lists only modules in eager outputs, largest first', () => {
    expect(eagerModules(fixtureMetafile(), EAGER)).toEqual([
      { module: 'src/Eager.tsx', bytes: 600 },
      { module: 'src/main.tsx', bytes: 300 },
      { module: '../../node_modules/.bun/react@19.0.0/node_modules/react/index.js', bytes: 100 },
    ]);
  });

  test('bytesByOwner sums per owner', () => {
    expect(
      bytesByOwner([
        { module: 'src/features/chat/A.tsx', bytes: 5 },
        { module: 'src/features/chat/B.tsx', bytes: 7 },
        { module: 'src/features/git/C.tsx', bytes: 9 },
      ])
    ).toEqual([
      { module: 'src/features/chat', bytes: 12 },
      { module: 'src/features/git', bytes: 9 },
    ]);
  });

  test('chunkStats counts lazy chunks and those under 1 KB, never the entry', () => {
    expect(chunkStats(fixtureMetafile(), EAGER)).toEqual({
      chunks: 4,
      smallChunks: 3,
      smallChunkBytes: 75 + 300 + 70,
      totalBytes: 75 + 5000 + 300 + 70,
    });
  });
});

describe('resolveScenario', () => {
  const lazyScenario: LoadScenario = {
    id: 'lazy',
    title: 'Open Lazy',
    steps: [{ from: 'src/main.tsx', to: ['src/Lazy.tsx'] }],
  };

  test('a stub in front of a shared chunk is one round and three requests', () => {
    const result = resolveScenario(fixtureMetafile(), EAGER, lazyScenario);
    // Bun preloads an import()'s static closure alongside the target, so the
    // stub, the shared chunk and `chunk-deep` go out together. `main` is eager
    // and costs nothing.
    expect(result.rounds).toBe(1);
    expect(result.requests).toBe(3);
    expect(result.steps[0]?.chunks).toEqual([
      'assets/chunk-Lazy-aaaaaaaa.js',
      'assets/chunk-shared-bbbbbbbb.js',
      'assets/chunk-deep-cccccccc.js',
    ]);
    expect(result.rawBytes).toBe(75 + 5000 + 300);
  });

  test('a module bundled into an eager chunk costs no request', () => {
    const result = resolveScenario(fixtureMetafile(), EAGER, {
      id: 'eager',
      title: 'Eager',
      steps: [{ from: 'src/main.tsx', to: ['src/Eager.tsx'] }],
    });
    expect(result).toMatchObject({ rounds: 0, requests: 0, rawBytes: 0 });
  });

  test('chunks an earlier step fetched are not counted again', () => {
    const result = resolveScenario(fixtureMetafile(), EAGER, {
      id: 'twice',
      title: 'Twice',
      steps: [
        { from: 'src/main.tsx', to: ['src/Lazy.tsx'] },
        { from: 'src/main.tsx', to: ['src/Lazy.tsx'] },
      ],
    });
    expect(result.requests).toBe(3);
    expect(result.steps[1]).toMatchObject({ rounds: 0, chunks: [] });
  });

  test('steps that wait on one another add a round each', () => {
    const result = resolveScenario(fixtureMetafile(), EAGER, {
      id: 'chain',
      title: 'Chain',
      steps: [
        { from: 'src/main.tsx', to: ['src/Lazy.tsx'] },
        { from: 'src/main.tsx', to: ['src/Second.tsx'] },
      ],
    });
    expect(result).toMatchObject({ rounds: 2, requests: 4 });
  });

  test('targets of one step load in parallel: one round for both', () => {
    const result = resolveScenario(fixtureMetafile(), EAGER, {
      id: 'parallel',
      title: 'Parallel',
      steps: [{ from: 'src/main.tsx', to: ['src/Lazy.tsx', 'src/Second.tsx'] }],
    });
    expect(result).toMatchObject({ rounds: 1, requests: 4 });
  });

  test('a module missing from the metafile names it', () => {
    expect(() =>
      resolveScenario(fixtureMetafile(), EAGER, {
        id: 'renamed',
        title: 'Renamed',
        steps: [{ from: 'src/main.tsx', to: ['src/Renamed.tsx'] }],
      })
    ).toThrow('scenario "renamed": module src/Renamed.tsx is not in the metafile');
  });

  test('a lazy module with no dynamic import from the caller is an error, not "free"', () => {
    expect(() =>
      resolveScenario(fixtureMetafile(), EAGER, {
        id: 'unreachable',
        title: 'Unreachable',
        steps: [{ from: 'src/main.tsx', to: ['src/Other.tsx'] }],
      })
    ).toThrow('has no dynamic import of src/Other.tsx');
  });
});

describe('budget', () => {
  const eager = {
    files: [{ path: 'assets/main.js', rawBytes: 10, gzipBytes: 5, brotliBytes: 4 }],
    rawBytes: 10,
    gzipBytes: 5,
    brotliBytes: 4,
  };

  test('parseBundleBudget accepts a positive integer limit', () => {
    expect(parseBundleBudget('{"eagerBrotliBytes": 100}', 'budget.json')).toEqual({
      eagerBrotliBytes: 100,
    });
  });

  test.each(['{}', '{"eagerBrotliBytes": "100"}', '{"eagerBrotliBytes": 0}', '[1]', 'null'])(
    'parseBundleBudget rejects %s and names the expected shape',
    (source) => {
      expect(() => parseBundleBudget(source, 'budget.json')).toThrow(
        'budget.json: expected {"eagerBrotliBytes": <positive integer>}'
      );
    }
  );

  const context = {
    budgetPath: 'scripts/ci/frontend-bundle-budget.json',
    bunRevision: '1.4.5+abc',
  };

  test('a payload at the limit passes and one byte over fails, naming both numbers', () => {
    expect(budgetViolation(eager, { eagerBrotliBytes: 4 }, context)).toBeUndefined();
    expect(budgetViolation(eager, { eagerBrotliBytes: 3 }, context)).toContain(
      'eager payload is 4 B Brotli over 1 files; the budget in scripts/ci/frontend-bundle-budget.json is 3 B (over by 1 B)'
    );
  });

  test('the failure names the budget file, the Bun revision and both ways out', () => {
    const message = budgetViolation(eager, { eagerBrotliBytes: 3 }, context) ?? '';
    expect(message).toContain('built with Bun 1.4.5+abc');
    expect(message).toContain(
      'raise "eagerBrotliBytes" in scripts/ci/frontend-bundle-budget.json in this PR'
    );
    expect(message).toContain('run this script without --budget and read "Largest eager modules"');
    // A dependency bump that grows the entry must not be told it is a lazy import.
    expect(message).not.toContain('A static import pulled');
  });

  test('the pass line carries the spare bytes, the budget file and the Bun revision', () => {
    expect(budgetSummary(eager, { eagerBrotliBytes: 10 }, context)).toBe(
      'eager 4 B Brotli within the 10 B budget in scripts/ci/frontend-bundle-budget.json (6 B spare), built with Bun 1.4.5+abc'
    );
  });
});

describe('scenarios against a recorded build', () => {
  // A trimmed copy of a real production metafile: every output, plus the inputs
  // the scenarios name. It guards the scenario definitions against the shape
  // Bun really emits, which the hand-built fixture above only imitates.
  async function recordedMetafile(): Promise<LoadGraphMetafile> {
    return (await Bun.file(
      join(import.meta.dir, 'fixtures/frontend-load-graph-metafile.json')
    ).json()) as LoadGraphMetafile;
  }

  /** The entry script: the one JS output Bun records for `src/main.tsx`. */
  function entryOutputs(metafile: LoadGraphMetafile): Set<string> {
    return new Set(
      Object.entries(metafile.outputs)
        .filter(
          ([path, output]) =>
            path.endsWith('.js') &&
            (output as { entryPoint?: string }).entryPoint === 'src/main.tsx'
        )
        .map(([path]) => path.replace(/^\.\//, ''))
    );
  }

  test.each(LOAD_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    'scenario %s resolves against a real metafile',
    async (_id, scenario) => {
      const metafile = await recordedMetafile();
      const result = resolveScenario(metafile, entryOutputs(metafile), scenario);
      expect(result.id).toBe(scenario.id);
      expect(result.requests, `requests for ${scenario.id}`).toBeGreaterThanOrEqual(0);
    }
  );

  test('the terminal and code block scenarios fetch chunks', async () => {
    const metafile = await recordedMetafile();
    const byId = new Map(
      LOAD_SCENARIOS.map((scenario) => [
        scenario.id,
        resolveScenario(metafile, entryOutputs(metafile), scenario),
      ])
    );
    expect(byId.get('terminal')?.requests, 'terminal requests').toBeGreaterThan(0);
    expect(byId.get('markdown-code')?.requests, 'markdown-code requests').toBeGreaterThan(0);
  });

  test('a renamed module is a collected problem under the budget gate and a throw otherwise', async () => {
    const metafile = await recordedMetafile();
    const renamed: LoadScenario = {
      id: 'renamed',
      title: 'Open the renamed view',
      steps: [{ from: 'src/features/terminal/LazyTerminalViewRenamed.tsx', to: ['src/x.tsx'] }],
    };
    const dist = await mkdtemp(join(tmpdir(), 'frontend-load-graph-renamed-'));
    try {
      await writeFile(join(dist, 'index.html'), '<!doctype html>');
      await expect(buildLoadGraphReport(dist, metafile, [renamed], 'throw')).rejects.toThrow(
        'scenario "renamed": module src/features/terminal/LazyTerminalViewRenamed.tsx is not in the metafile'
      );
      const report = await buildLoadGraphReport(dist, metafile, [renamed], 'collect');
      expect(report.scenarios).toEqual([]);
      expect(report.scenarioProblems).toHaveLength(1);
      const rendered = renderLoadGraphReport(report, 1);
      expect(rendered).toContain('### Scenario problems');
      expect(rendered).toContain('LOAD_SCENARIOS in scripts/ci/frontend-load-graph.ts');
      expect(rendered).toContain('LazyTerminalViewRenamed.tsx');
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe('measured dist', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  async function fixtureDist(): Promise<string> {
    const dist = await mkdtemp(join(tmpdir(), 'frontend-load-graph-'));
    directories.push(dist);
    const files: Record<string, string> = {
      'index.html':
        '<!doctype html><link rel="preload" href="/fonts/body-latin.woff2"><script type="module" src="/assets/main-mmmmmmmm.js"></script>',
      'assets/main-mmmmmmmm.js': `import("./chunk-Lazy-aaaaaaaa.js");const logo="/assets/logo-aaaaaaaa.png";const gone="/assets/missing-aaaaaaaa.png";${'a'.repeat(2000)}`,
      'assets/logo-aaaaaaaa.png': 'x'.repeat(300),
      'fonts/body-latin.woff2': 'y'.repeat(500),
      'assets/chunk-Lazy-aaaaaaaa.js': 'import "./chunk-shared-bbbbbbbb.js";',
      'assets/chunk-shared-bbbbbbbb.js': 'export const x = 1;',
      'assets/chunk-deep-cccccccc.js': 'export const y = 2;',
      'assets/chunk-tiny-dddddddd.js': 'export const z = 3;',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dist, path)), { recursive: true });
      await writeFile(join(dist, path), content);
    }
    return dist;
  }

  test('brotliSize is deterministic and smaller than a repetitive input', () => {
    const bytes = new TextEncoder().encode('abc'.repeat(1000));
    expect(brotliSize(bytes)).toBe(brotliSize(bytes));
    expect(brotliSize(bytes)).toBeLessThan(bytes.byteLength / 10);
  });

  test('measureEagerPayload sums the entry and the shell, in every encoding', async () => {
    const dist = await fixtureDist();
    const report = await buildLoadGraphReport(dist, fixtureMetafile(), []);
    expect(report.eager.files.map((file) => file.path)).toEqual([
      'assets/main-mmmmmmmm.js',
      'index.html',
    ]);
    expect(report.eager.rawBytes).toBe(
      report.eager.files.reduce((sum, file) => sum + file.rawBytes, 0)
    );
    expect(report.eager.brotliBytes).toBeGreaterThan(0);
    expect(report.eager.brotliBytes).toBeLessThan(report.eager.rawBytes);
    // Same inputs through the exported helper agree with the report.
    const again = await measureEagerPayload(
      dist,
      report.eager.files.map((file) => ({ ...file, key: file.path, eager: true }))
    );
    expect(again.brotliBytes).toBe(report.eager.brotliBytes);
  });

  test('measureEagerAssets lists the images and fonts eager files name, skipping missing ones', async () => {
    const dist = await fixtureDist();
    expect(await measureEagerAssets(dist, ['index.html', 'assets/main-mmmmmmmm.js'])).toEqual([
      { path: 'assets/logo-aaaaaaaa.png', bytes: 300 },
      { path: 'fonts/body-latin.woff2', bytes: 500 },
    ]);
  });

  test('the rendered report carries the eager table, chunk counts and feature rows', async () => {
    const dist = await fixtureDist();
    const report = await buildLoadGraphReport(dist, fixtureMetafile(), [
      { id: 'lazy', title: 'Open Lazy', steps: [{ from: 'src/main.tsx', to: ['src/Lazy.tsx'] }] },
    ]);
    const rendered = renderLoadGraphReport(report, 5);
    expect(rendered).toContain('| assets/main-mmmmmmmm.js |');
    expect(rendered).toContain('assets/logo-aaaaaaaa.png 300 B');
    expect(rendered).toContain('Lazy chunks: 4 (3 under 1024 B');
    expect(rendered).toContain('| Open Lazy | 1 | 3 | 5375 |');
  });
});
