import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type BundleFile,
  type BundleReport,
  findDuplicatedModules,
  formatBytes,
  labelFiles,
  measureBundle,
  parseBundleReport,
  renderBundleReport,
  renderDuplicatedModules,
  stripContentHash,
} from '../ci/frontend-bundle-report';

const META = { builder: 'vite', capturedAt: '2026-08-20' } as const;

function report(files: BundleReport['files'], builder = 'bun'): BundleReport {
  const sorted = [...files].sort(
    (a, b) => b.gzipBytes - a.gzipBytes || a.path.localeCompare(b.path)
  );
  const total = (select: (file: BundleFile) => boolean, of: (file: BundleFile) => number): number =>
    sorted.filter(select).reduce((sum, file) => sum + of(file), 0);
  return {
    version: 2,
    builder,
    capturedAt: '2026-08-20',
    totals: {
      files: sorted.length,
      rawBytes: total(
        () => true,
        (f) => f.rawBytes
      ),
      gzipBytes: total(
        () => true,
        (f) => f.gzipBytes
      ),
      eagerRawBytes: total(
        (f) => f.eager,
        (f) => f.rawBytes
      ),
      eagerGzipBytes: total(
        (f) => f.eager,
        (f) => f.gzipBytes
      ),
    },
    files: sorted,
  };
}

function file(
  path: string,
  rawBytes: number,
  gzipBytes: number,
  eager = false
): BundleReport['files'][number] {
  return { path, key: stripContentHash(path), rawBytes, gzipBytes, eager };
}

describe('stripContentHash', () => {
  test('drops the hash a bundler appended, keeping the directory and extension', () => {
    expect(stripContentHash('assets/index-Bqugzlgv.js')).toBe('assets/index.js');
    expect(stripContentHash('assets/index-BsVw1vtW.css')).toBe('assets/index.css');
  });

  test("drops Bun's all-lowercase base36 hash, not just Vite's base64url one", () => {
    // Measured from Bun.build: 8 lowercase base36 chars. ~4% of them contain no
    // digit at all, so a "must look random" test would reject them at random and
    // report an unchanged file as both added and removed.
    expect(stripContentHash('assets/entry-htt6v99t.js')).toBe('assets/entry.js');
    expect(stripContentHash('assets/style-tkc6pwra.css')).toBe('assets/style.css');
    expect(stripContentHash('assets/chunk-abcdefgh.js')).toBe('assets/chunk.js');
  });

  test('keeps a multi-segment chunk name intact', () => {
    // A leftmost `-[A-Za-z0-9_-]{8,}` match would collapse this to
    // `assets/markdown.js` and hide the parser chunk behind the language one.
    expect(stripContentHash('assets/markdown-parser-MlRw1Qxl.js')).toBe(
      'assets/markdown-parser.js'
    );
    expect(stripContentHash('assets/vendor-deps-BqemZtDc.js')).toBe('assets/vendor-deps.js');
  });

  test('handles a base64url hash that contains a dash', () => {
    // Vite emitted exactly this. The rightmost '-' leaves only 'NmKLT', so the
    // scan has to keep walking left before it finds the real boundary.
    expect(stripContentHash('assets/php-Th-NmKLT.js')).toBe('assets/php.js');
  });

  test('leaves an unhashed file alone', () => {
    expect(stripContentHash('index.html')).toBe('index.html');
    expect(stripContentHash('favicon.ico')).toBe('favicon.ico');
    expect(stripContentHash('site.webmanifest')).toBe('site.webmanifest');
    // Nothing long enough to be a hash.
    expect(stripContentHash('assets/go-abc.js')).toBe('assets/go-abc.js');
    // 'touch-icon' is longer than any hash either bundler emits, and reads as a
    // name rather than one, so the scan stops instead of yielding 'apple.png'.
    expect(stripContentHash('apple-touch-icon.png')).toBe('apple-touch-icon.png');
  });

  test('over-strips an 8-character name segment, symmetrically', () => {
    // The accepted cost of taking every 8-character suffix as a hash. Both sides
    // of a diff strip it the same way, so the row still matches; only the label
    // is short. The alternative — random phantom churn — is worse.
    expect(stripContentHash('assets/chat-messages.js')).toBe('assets/chat.js');
  });

  test('keeps a compound extension whole', () => {
    expect(stripContentHash('assets/index-Bqugzlgv.js.map')).toBe('assets/index.js.map');
  });
});

describe('formatBytes', () => {
  test('scales to the unit that keeps a bundle number readable', () => {
    expect(formatBytes(82)).toBe('82 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(1024 ** 2 + 1024 ** 2 / 2)).toBe('1.50 MB');
  });
});

describe('labelFiles', () => {
  test('labels a lone file with its bare key', () => {
    const files = [file('assets/index-Bqugzlgv.js', 100, 40)];
    expect(labelFiles(files).get(files[0] as BundleFile)).toBe('assets/index.js');
  });

  test('disambiguates same-keyed files by gzip-size rank', () => {
    // Bun once emitted 17 `chunk-main-*.js` files that rendered as a single
    // summed row; the total was right but every individual chunk was invisible.
    const big = file('assets/chunk-main-CJeZLqOC.js', 300, 120);
    const small = file('assets/chunk-main-Bqugzlgv.js', 100, 40);
    const labels = labelFiles([small, big]);
    expect(labels.get(big)).toBe('assets/chunk-main.js #1');
    expect(labels.get(small)).toBe('assets/chunk-main.js #2');
  });
});

describe('renderBundleReport', () => {
  test('ranks chunks by gzipped size, marks eagerness, and totals the bundle', () => {
    const rendered = renderBundleReport(
      report([
        file('assets/small-Bqugzlgv.js', 100, 40),
        file('assets/big-CJeZLqOC.js', 900, 400, true),
      ])
    );

    const rows = rendered
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.includes('---'));
    expect(rows[0]).toContain('| Chunk |');
    expect(rows[1]).toBe('| assets/big.js | eager | 900 B | 400 B |');
    expect(rows[2]).toBe('| assets/small.js | lazy | 100 B | 40 B |');
    expect(rows[3]).toBe('| **Eager (first paint)** |  | **900 B** | **400 B** |');
    expect(rows[4]).toBe('| **Total (2 files)** |  | **1000 B** | **440 B** |');
    // No baseline, so no delta column to mislead a reader.
    expect(rendered).not.toContain('Δ gzip');
  });

  test('diffs against a baseline through the hash-stripped key', () => {
    // Different hashes on both sides: a path-keyed diff would call every row new.
    const baseline = report([file('assets/index-Bqugzlgv.js', 1000, 500, true)], 'vite');
    const current = report([file('assets/index-CJeZLqOC.js', 1200, 600, true)]);

    const rendered = renderBundleReport(current, baseline);

    expect(rendered).toContain('Compared against `vite` captured 2026-08-20.');
    expect(rendered).toContain('| assets/index.js | eager | 1.2 kB | 600 B | +100 B (+20.0%) |');
    expect(rendered).toContain(
      '| **Total (1 files)** |  | **1.2 kB** | **600 B** | **+100 B (+20.0%)** |'
    );
  });

  test('diffs the eager total separately from the grand total', () => {
    // The whole point of the eager split: total flat, first paint regressed.
    const baseline = report(
      [file('assets/index-Bqugzlgv.js', 1000, 500, true), file('assets/cpp-CiVOhWHe.js', 800, 300)],
      'vite'
    );
    const current = report([
      file('assets/index-CJeZLqOC.js', 1800, 800, true),
      file('assets/cpp-BqemZtDc.js', 0, 0),
    ]);

    const rendered = renderBundleReport(current, baseline);
    expect(rendered).toContain(
      '| **Eager (first paint)** |  | **1.8 kB** | **800 B** | **+300 B (+60.0%)** |'
    );
    expect(rendered).toContain('| **Total (2 files)** |  | **1.8 kB** | **800 B** | **—** |');
  });

  test('marks an unchanged chunk rather than printing a zero', () => {
    const baseline = report([file('assets/index-Bqugzlgv.js', 1000, 500)], 'vite');
    const current = report([file('assets/index-CJeZLqOC.js', 1000, 500)]);

    expect(renderBundleReport(current, baseline)).toContain(
      '| assets/index.js | lazy | 1000 B | 500 B | — |'
    );
  });

  test('renders one row per file when several collapse onto one key', () => {
    const rendered = renderBundleReport(
      report([
        file('assets/chunk-main-Bqugzlgv.js', 100, 40),
        file('assets/chunk-main-CJeZLqOC.js', 300, 120),
        file('assets/index-BqemZtDc.js', 50, 20),
      ])
    );

    expect(rendered).toContain('| assets/chunk-main.js #1 | lazy | 300 B | 120 B |');
    expect(rendered).toContain('| assets/chunk-main.js #2 | lazy | 100 B | 40 B |');
    expect(rendered).toContain('| assets/index.js | lazy | 50 B | 20 B |');
  });

  test('calls out chunks the migration added and removed', () => {
    const baseline = report(
      [
        file('assets/index-Bqugzlgv.js', 1000, 500),
        file('assets/syntax-core-CJeZLqOC.js', 800, 300),
      ],
      'vite'
    );
    const current = report([
      file('assets/index-CJeZLqOC.js', 1000, 500),
      file('assets/chunk-BqemZtDc.js', 200, 90),
    ]);

    const rendered = renderBundleReport(current, baseline);

    expect(rendered).toContain('| assets/chunk.js | lazy | 200 B | 90 B | new |');
    expect(rendered).toContain('Gone from the baseline: `assets/syntax-core.js`');
  });
});

describe('findDuplicatedModules', () => {
  test('reports a module that landed in more than one js chunk', () => {
    const duplicated = findDuplicatedModules({
      outputs: {
        './assets/main-abc12345.js': {
          inputs: { 'src/main.tsx': {}, 'node_modules/react/index.js': {} },
        },
        './assets/chunk-x-abc12345.js': {
          inputs: { 'src/lazy.tsx': {}, 'node_modules/react/index.js': {} },
        },
        // A css output sharing a source with a js chunk is not duplication.
        './assets/main-abc12345.css': { inputs: { 'src/main.tsx': {} } },
      },
    });

    expect([...duplicated.keys()]).toEqual(['node_modules/react/index.js']);
    expect(renderDuplicatedModules(duplicated)).toContain('`node_modules/react/index.js` × 2');
  });

  test('says so when nothing is duplicated', () => {
    expect(renderDuplicatedModules(new Map())).toBe('No module is present in more than one chunk.');
  });
});

describe('parseBundleReport', () => {
  test('accepts a report this script wrote', () => {
    const source = JSON.stringify(report([file('assets/index-Bqugzlgv.js', 10, 5)]));
    expect(parseBundleReport(source, 'baseline.json').totals.files).toBe(1);
  });

  test('rejects a baseline from an older format instead of diffing it as churn', () => {
    // Version 1 predates the eager/lazy split; diffing it would render every
    // eager number against an undefined baseline.
    const source = JSON.stringify({ ...report([]), version: 1 });
    expect(() => parseBundleReport(source, 'baseline.json')).toThrow(/version 1/);
  });
});

describe('measureBundle', () => {
  test('walks static imports from index.html to split eager from lazy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-bundle-report-'));
    try {
      await mkdir(join(dir, 'assets'));
      // The shell references the entry and stylesheet with absolute URLs (Bun's
      // publicPath form); the entry reaches one chunk statically (Vite's
      // relative form) and one only dynamically — that one must stay lazy.
      await writeFile(
        join(dir, 'index.html'),
        '<link rel="stylesheet" crossorigin href="/assets/main-abc12345.css" />\n' +
          '<script type="module" crossorigin src="/assets/main-abc12345.js"></script>\n'
      );
      await writeFile(
        join(dir, 'assets', 'main-abc12345.js'),
        'import{a}from"./chunk-static-abc12345.js";import("/assets/chunk-lazy-abc12345.js");\n'
      );
      await writeFile(join(dir, 'assets', 'main-abc12345.css'), 'body{}\n');
      await writeFile(join(dir, 'assets', 'chunk-static-abc12345.js'), 'export const a=1;\n');
      await writeFile(join(dir, 'assets', 'chunk-lazy-abc12345.js'), 'export const b=2;\n');
      // Sourcemaps are a diagnostic artifact, not shipped payload.
      await writeFile(join(dir, 'assets', 'main-abc12345.js.map'), '{}\n');

      const measured = await measureBundle(dir, META);

      expect(measured.builder).toBe('vite');
      expect(measured.totals.files).toBe(5);
      const eagerness = new Map(measured.files.map((entry) => [entry.path, entry.eager]));
      expect(eagerness.get('index.html')).toBe(true);
      expect(eagerness.get('assets/main-abc12345.js')).toBe(true);
      expect(eagerness.get('assets/main-abc12345.css')).toBe(true);
      expect(eagerness.get('assets/chunk-static-abc12345.js')).toBe(true);
      expect(eagerness.get('assets/chunk-lazy-abc12345.js')).toBe(false);
      expect(measured.files.map((entry) => entry.path)).not.toContain(
        'assets/main-abc12345.js.map'
      );
      expect(measured.totals.eagerGzipBytes).toBeLessThan(measured.totals.gzipBytes);
      expect(measured.totals.rawBytes).toBe(
        measured.files.reduce((total, entry) => total + entry.rawBytes, 0)
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
