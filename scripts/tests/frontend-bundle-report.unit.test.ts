import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type BundleReport,
  formatBytes,
  measureBundle,
  parseBundleReport,
  renderBundleReport,
  stripContentHash,
  totalsByKey,
} from '../ci/frontend-bundle-report';

const META = { builder: 'vite', capturedAt: '2026-08-20' } as const;

function report(files: BundleReport['files'], builder = 'bun'): BundleReport {
  return {
    version: 1,
    builder,
    capturedAt: '2026-08-20',
    totals: {
      files: files.length,
      rawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
      gzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    },
    files,
  };
}

function file(path: string, rawBytes: number, gzipBytes: number): BundleReport['files'][number] {
  return { path, key: stripContentHash(path), rawBytes, gzipBytes };
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

describe('totalsByKey', () => {
  test('sums the files that collapse onto one hash-stripped key', () => {
    const totals = totalsByKey(
      report([
        file('assets/index-Bqugzlgv.js', 100, 40),
        file('assets/index-CJeZLqOC.js', 50, 20),
        file('assets/index-BsVw1vtW.css', 10, 5),
      ])
    );

    expect(totals.get('assets/index.js')).toEqual({ files: 2, rawBytes: 150, gzipBytes: 60 });
    expect(totals.get('assets/index.css')).toEqual({ files: 1, rawBytes: 10, gzipBytes: 5 });
  });
});

describe('renderBundleReport', () => {
  test('ranks chunks by gzipped size and totals the bundle', () => {
    const rendered = renderBundleReport(
      report([file('assets/small-Bqugzlgv.js', 100, 40), file('assets/big-CJeZLqOC.js', 900, 400)])
    );

    const rows = rendered
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.includes('---'));
    expect(rows[0]).toContain('| Chunk |');
    expect(rows[1]).toBe('| assets/big.js | 900 B | 400 B |');
    expect(rows[2]).toBe('| assets/small.js | 100 B | 40 B |');
    expect(rows[3]).toBe('| **Total (2 files)** | **1000 B** | **440 B** |');
    // No baseline, so no delta column to mislead a reader.
    expect(rendered).not.toContain('Δ gzip');
  });

  test('diffs against a baseline through the hash-stripped key', () => {
    // Different hashes on both sides: a path-keyed diff would call every row new.
    const baseline = report([file('assets/index-Bqugzlgv.js', 1000, 500)], 'vite');
    const current = report([file('assets/index-CJeZLqOC.js', 1200, 600)]);

    const rendered = renderBundleReport(current, baseline);

    expect(rendered).toContain('Compared against `vite` captured 2026-08-20.');
    expect(rendered).toContain('| assets/index.js | 1.2 kB | 600 B | +100 B (+20.0%) |');
    expect(rendered).toContain(
      '| **Total (1 files)** | **1.2 kB** | **600 B** | **+100 B (+20.0%)** |'
    );
  });

  test('marks an unchanged chunk rather than printing a zero', () => {
    const baseline = report([file('assets/index-Bqugzlgv.js', 1000, 500)], 'vite');
    const current = report([file('assets/index-CJeZLqOC.js', 1000, 500)]);

    expect(renderBundleReport(current, baseline)).toContain(
      '| assets/index.js | 1000 B | 500 B | — |'
    );
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

    expect(rendered).toContain('| assets/chunk.js | 200 B | 90 B | new |');
    expect(rendered).toContain('Gone from the baseline: `assets/syntax-core.js`');
  });
});

describe('parseBundleReport', () => {
  test('accepts a report this script wrote', () => {
    const source = JSON.stringify(report([file('assets/index-Bqugzlgv.js', 10, 5)]));
    expect(parseBundleReport(source, 'baseline.json').totals.files).toBe(1);
  });

  test('rejects a baseline from an older format instead of diffing it as churn', () => {
    const source = JSON.stringify({ ...report([]), version: 0 });
    expect(() => parseBundleReport(source, 'baseline.json')).toThrow(/version 0/);
  });
});

describe('measureBundle', () => {
  test('measures every file under dist, nested directories included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-bundle-report-'));
    try {
      await mkdir(join(dir, 'assets'));
      await writeFile(join(dir, 'index.html'), '<!doctype html>\n', 'utf8');
      await writeFile(join(dir, 'assets', 'index-Bqugzlgv.js'), 'console.log(1);\n'.repeat(20));

      const measured = await measureBundle(dir, META);

      expect(measured.builder).toBe('vite');
      expect(measured.totals.files).toBe(2);
      expect(measured.files.map((entry) => entry.key)).toEqual(['assets/index.js', 'index.html']);
      // Largest gzipped first, and gzip is measured rather than estimated.
      expect(measured.files[0]?.gzipBytes).toBeGreaterThan(measured.files[1]?.gzipBytes ?? 0);
      expect(measured.totals.rawBytes).toBe(
        measured.files.reduce((total, entry) => total + entry.rawBytes, 0)
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
