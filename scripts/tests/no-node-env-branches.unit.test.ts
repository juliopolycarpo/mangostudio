import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoProductionNodeEnvBranches,
  findDisallowedNodeEnvReads,
} from '../lib/no-node-env-branches';

const tempDirs: string[] = [];

/** A root the tree scan can glob, holding one production source file. */
const makeSourceTree = (relativePath: string, content: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'mango-node-env-guard-'));
  tempDirs.push(root);
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  return root;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('production NODE_ENV guard', () => {
  it('rejects direct and bracket access outside the allowlist', () => {
    const violations = findDisallowedNodeEnvReads([
      {
        path: 'apps/api/src/new-service.ts',
        content:
          'const mode = process.env.NODE_ENV;\n' +
          'const other = process.env["NODE_ENV"];\n' +
          'const { NODE_ENV } = process.env;',
      },
    ]);

    expect(violations.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: 'apps/api/src/new-service.ts', line: 1 },
      { path: 'apps/api/src/new-service.ts', line: 2 },
      { path: 'apps/api/src/new-service.ts', line: 3 },
    ]);
  });

  // The guard skips the TypeScript parse for files with no `NODE_ENV`
  // substring, so the escaped spellings the parser still decodes to that token
  // are exactly what a fast path is liable to lose.
  it('still catches a NODE_ENV token spelled with escapes', () => {
    const escapedIdentifier = 'const mode = process.env.NODE_EN\\u0056;';
    const escapedLiteral = 'const other = process.env["NODE_EN\\x56"];';
    expect(escapedIdentifier.includes('NODE_ENV')).toBe(false);
    expect(escapedLiteral.includes('NODE_ENV')).toBe(false);

    expect(
      findDisallowedNodeEnvReads([
        { path: 'apps/api/src/escaped.ts', content: `${escapedIdentifier}\n${escapedLiteral}` },
      ]).map(({ line }) => line)
    ).toEqual([1, 2]);
  });

  it('reports nothing for a file that never names NODE_ENV', () => {
    expect(
      findDisallowedNodeEnvReads([
        {
          path: 'apps/api/src/unrelated.ts',
          content: 'const pattern = /a\\.b/;\nexport const mode = process.env.MANGO_MODE;',
        },
      ])
    ).toEqual([]);
  });

  it('does not exempt an unmarked read in a file that also holds a marked one', () => {
    expect(
      findDisallowedNodeEnvReads([
        {
          path: 'apps/api/src/lib/config.ts',
          content:
            '// allow-node-env: the intentional one\n' +
            'const seam = process.env.NODE_ENV;\n' +
            '\n' +
            'const mode = process.env.NODE_ENV;',
        },
      ]).map(({ line }) => line)
    ).toEqual([4]);
  });

  it('accepts a read marked above it or trailing on its own line', () => {
    expect(
      findDisallowedNodeEnvReads([
        {
          path: 'apps/api/src/marked.ts',
          content:
            '// allow-node-env: reasoned\n' +
            'const above = process.env.NODE_ENV;\n' +
            'const trailing = process.env.NODE_ENV; // allow-node-env: reasoned\n' +
            '/**\n' +
            ' * allow-node-env: reasoned inside a docstring\n' +
            ' */\n' +
            'const block = process.env.NODE_ENV;',
        },
      ])
    ).toEqual([]);
  });

  // The marker excuses the read it sits against, never one further down: a
  // blank line ends the comment run, which is what stops a stale marker from
  // drifting onto an unrelated read the way an absolute line number could.
  it('does not let a marker reach past a blank line', () => {
    expect(
      findDisallowedNodeEnvReads([
        {
          path: 'apps/api/src/distant.ts',
          content:
            '// allow-node-env: reasoned\n' + '\n' + 'const detached = process.env.NODE_ENV;',
        },
      ]).map(({ line }) => line)
    ).toEqual([3]);
  });

  // The tree scan reads and filters files before the parser sees them, so it
  // can drop an escaped spelling that `findDisallowedNodeEnvReads` would catch.
  // Asserting through the entry point is what pins the two filters together.
  it('catches an escaped NODE_ENV spelling through the tree scan', () => {
    const escaped = 'export const mode = process.env.NODE_EN\\u0056;\n';
    expect(escaped.includes('NODE_ENV')).toBe(false);
    const root = makeSourceTree('apps/api/src/escaped.ts', escaped);

    expect(() => assertNoProductionNodeEnvBranches(root)).toThrow(/apps\/api\/src\/escaped\.ts:1:/);
  });

  it('accepts a scanned file whose backslash is not an escaped NODE_ENV', () => {
    const root = makeSourceTree(
      'apps/api/src/unrelated.ts',
      'const pattern = /a\\.b/;\nexport const mode = process.env.MANGO_MODE;\n'
    );

    expect(() => assertNoProductionNodeEnvBranches(root)).not.toThrow();
  });

  it('passes against the current production source tree', () => {
    expect(() => assertNoProductionNodeEnvBranches()).not.toThrow();
  }, 15_000);
});
