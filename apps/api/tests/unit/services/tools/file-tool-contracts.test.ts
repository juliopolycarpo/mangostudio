/**
 * Invariants that only exist between filesystem tools, and so belong to none of
 * them — starting with: a path one tool reports can be fed into another and
 * reach the same file.
 *
 * Broken by two tools agreeing with themselves and disagreeing with each other,
 * which is exactly what a per-tool suite cannot catch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGlob } from '../../../../src/services/tools/builtin/glob';
import { executeGrep } from '../../../../src/services/tools/builtin/grep';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import { clearFileFreshness } from '../../../../src/services/tools/file-freshness';
import type { ToolContext } from '../../../../src/services/tools/types';

let workdir: string;

beforeEach(() => {
  clearFileFreshness();
  workdir = mkdtempSync(join(tmpdir(), 'file-tool-contracts-'));
  mkdirSync(join(workdir, 'src', 'deep'), { recursive: true });
});

afterEach(() => {
  clearFileFreshness();
  rmSync(workdir, { recursive: true, force: true });
});

function context(parameters: Record<string, unknown> = {}): ToolContext {
  return { userId: 'u1', chatId: 'c1', parameters, workdir };
}

describe('a reported path can be read back', () => {
  // The search root is deliberately below the workdir: when the two are the
  // same, a search-root-relative path and a workdir-relative one are identical
  // and the bug is invisible.
  it('feeds a grep match straight into read_file', async () => {
    await Bun.write(join(workdir, 'src', 'deep', 'a.ts'), 'const marker = 1;\n');

    const grepped = await executeGrep({ pattern: 'marker', path: 'src' }, context());
    const file = grepped.matches[0]?.file;
    expect(file).toBe(join('src', 'deep', 'a.ts'));

    const read = await executeReadFile({ path: file as string }, context());
    expect(read.content).toContain('const marker = 1;');
  });

  it('feeds a glob match straight into read_file', async () => {
    await Bun.write(join(workdir, 'src', 'deep', 'b.ts'), 'export const b = 2;\n');

    const globbed = await executeGlob({ pattern: '**/*.ts', cwd: 'src' }, context());
    const match = globbed.matches[0];
    expect(match).toBe(join('src', 'deep', 'b.ts'));

    const read = await executeReadFile({ path: match as string }, context());
    expect(read.content).toContain('export const b = 2;');
  });

  it('feeds a grep match into read_file under a workdir-restricted chat', async () => {
    await Bun.write(join(workdir, 'src', 'deep', 'c.ts'), 'const marker = 3;\n');
    const restricted: ToolContext = {
      ...context(),
      workdirPolicy: { root: workdir, restricted: true },
    };

    const grepped = await executeGrep({ pattern: 'marker', path: 'src' }, restricted);
    const file = grepped.matches[0]?.file;

    // Containment turns the old bug from a plain not-found into a refusal for
    // reaching outside the working directory, which is worse to diagnose.
    const read = await executeReadFile({ path: file as string }, restricted);
    expect(read.content).toContain('const marker = 3;');
  });

  it('agrees with glob when both search the same root', async () => {
    await Bun.write(join(workdir, 'src', 'deep', 'shared.ts'), 'const marker = 4;\n');

    const grepped = await executeGrep({ pattern: 'marker', path: 'src' }, context());
    const globbed = await executeGlob({ pattern: '**/shared.ts', cwd: 'src' }, context());

    expect(grepped.matches[0]?.file).toBe(globbed.matches[0] as string);
  });
});
