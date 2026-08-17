/**
 * Invariants that only exist between filesystem tools, and so belong to none of
 * them: a path one tool reports can be fed into another and reach the same file,
 * and one file classifies the same way everywhere.
 *
 * Each half was broken by two tools agreeing with themselves and disagreeing
 * with each other, which is exactly what a per-tool suite cannot catch.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { executeGlob } from '../../../../src/services/tools/builtin/glob';
import { executeGrep } from '../../../../src/services/tools/builtin/grep';
import { executeReadFile } from '../../../../src/services/tools/builtin/read-file';
import type { ToolContext } from '../../../../src/services/tools/types';
import { useToolRegistry } from './support/tool-registry-harness';

const harness = useToolRegistry('file-tool-contracts');
const context = (parameters: Record<string, unknown> = {}): ToolContext =>
  harness.context(parameters);

beforeEach(() => {
  mkdirSync(harness.path('src', 'deep'), { recursive: true });
});

describe('a reported path can be read back', () => {
  // The search root is deliberately below the workdir: when the two are the
  // same, a search-root-relative path and a workdir-relative one are identical
  // and the bug is invisible.
  it('feeds a grep match straight into read_file', async () => {
    await Bun.write(harness.path('src', 'deep', 'a.ts'), 'const marker = 1;\n');

    const grepped = await executeGrep({ pattern: 'marker', path: 'src' }, context());
    const file = grepped.matches[0]?.file;
    expect(file).toBe(join('src', 'deep', 'a.ts'));

    const read = await executeReadFile({ path: file as string }, context());
    expect(read.content).toContain('const marker = 1;');
  });

  it('feeds a glob match straight into read_file', async () => {
    await Bun.write(harness.path('src', 'deep', 'b.ts'), 'export const b = 2;\n');

    const globbed = await executeGlob({ pattern: '**/*.ts', cwd: 'src' }, context());
    const match = globbed.matches[0];
    expect(match).toBe(join('src', 'deep', 'b.ts'));

    const read = await executeReadFile({ path: match as string }, context());
    expect(read.content).toContain('export const b = 2;');
  });

  it('feeds a grep match into read_file under a workdir-restricted chat', async () => {
    await Bun.write(harness.path('src', 'deep', 'c.ts'), 'const marker = 3;\n');
    const restricted: ToolContext = {
      ...context(),
      workdirPolicy: { root: harness.dir, restricted: true },
    };

    const grepped = await executeGrep({ pattern: 'marker', path: 'src' }, restricted);
    const file = grepped.matches[0]?.file;

    // Containment turns the old bug from a plain not-found into a refusal for
    // reaching outside the working directory, which is worse to diagnose.
    const read = await executeReadFile({ path: file as string }, restricted);
    expect(read.content).toContain('const marker = 3;');
  });

  it('agrees with glob when both search the same root', async () => {
    await Bun.write(harness.path('src', 'deep', 'shared.ts'), 'const marker = 4;\n');

    const grepped = await executeGrep({ pattern: 'marker', path: 'src' }, context());
    const globbed = await executeGlob({ pattern: '**/shared.ts', cwd: 'src' }, context());

    expect(grepped.matches[0]?.file).toBe(globbed.matches[0] as string);
  });
});

describe('one file classifies the same way for every tool', () => {
  /** Text, then a NUL past grep's old 1 KiB probe but inside read_file's 8 KiB. */
  async function seedLateNul(name: string, nulOffset: number): Promise<string> {
    const filePath = harness.path(name);
    const head = new TextEncoder().encode(`marker\n${'a'.repeat(nulOffset - 7)}`);
    const bytes = new Uint8Array(head.byteLength + 8);
    bytes.set(head);
    await Bun.write(filePath, bytes);
    return filePath;
  }

  it('treats a file with a NUL at byte 2000 as binary in both grep and read_file', async () => {
    await seedLateNul('late-nul.dat', 2000);

    const grepped = await executeGrep({ pattern: 'marker', path: '.' }, context());
    const read = await executeReadFile({ path: 'late-nul.dat' }, context()).catch(
      (thrown: unknown) => thrown
    );

    // The disagreement this replaces: grep probed 1 KiB, read_file 8 KiB, so
    // this exact file was searchable and then unreadable.
    expect(grepped.matches).toEqual([]);
    expect((read as Error).message).toMatch(/appears to be a binary file/);
  });

  it('treats a file whose NUL is past both probes as text in both', async () => {
    await seedLateNul('very-late-nul.dat', 20_000);

    const grepped = await executeGrep({ pattern: 'marker', path: '.' }, context());
    const read = await executeReadFile({ path: 'very-late-nul.dat' }, context());

    expect(grepped.matches.map((match) => match.file)).toEqual(['very-late-nul.dat']);
    expect(read.content).toContain('marker');
  });
});
