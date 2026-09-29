import { describe, expect, it } from 'bun:test';

import { countCircularDeps } from './circular';

/** Named fake of madge: cycles per root, recording which roots were asked. */
const makeFakeMadge = (cyclesByRoot: Readonly<Record<string, unknown>>) => {
  const roots: string[] = [];
  const run = (cmd: readonly string[]) => {
    const root = cmd.at(-1) ?? '';
    roots.push(root);
    return Promise.resolve({
      stdout: JSON.stringify(cyclesByRoot[root] ?? []),
      stderr: '',
      exitCode: 0,
    });
  };
  return { run, roots };
};

describe('countCircularDeps', () => {
  it('sums cycles over exactly the roots it is given', async () => {
    const madge = makeFakeMadge({
      'apps/api': [['a.ts', 'b.ts']],
      'packages/protocol': [
        ['x.ts', 'y.ts'],
        ['p.ts', 'q.ts'],
      ],
      'apps/unlisted': [['z.ts', 'w.ts']],
    });

    const total = await countCircularDeps(['apps/api', 'packages/protocol', 'apps/web'], madge.run);

    expect(total).toBe(3);
    expect(madge.roots.sort()).toEqual(['apps/api', 'apps/web', 'packages/protocol']);
  });

  it('counts a root discovered later (a new workspace) without a code change', async () => {
    const madge = makeFakeMadge({ 'apps/web': [['a.ts', 'b.ts']] });

    expect(await countCircularDeps(['apps/web'], madge.run)).toBe(1);
  });

  // madge exits 1 both when it finds cycles (JSON on stdout) and when it fails
  // (nothing on stdout), so the exit code alone cannot tell them apart.
  it('counts cycles even though madge exits 1 when it finds them', async () => {
    const run = () => Promise.resolve({ stdout: '[["a.ts","b.ts"]]', stderr: '', exitCode: 1 });

    expect(await countCircularDeps(['apps/api'], run)).toBe(1);
  });

  it('fails, with the exit code and stderr, when madge printed nothing instead of counting zero cycles', async () => {
    const run = () =>
      Promise.resolve({ stdout: '  ', stderr: '✖ Error: ENOENT: no such file', exitCode: 1 });

    await expect(countCircularDeps(['apps/api'], run)).rejects.toThrow(
      'madge printed no output for apps/api (exit 1): ✖ Error: ENOENT: no such file'
    );
  });

  it('rejects output that is not a list of cycles, naming the root and value', async () => {
    const run = () => Promise.resolve({ stdout: '{"error":"boom"}', stderr: '', exitCode: 0 });

    await expect(countCircularDeps(['apps/api'], run)).rejects.toThrow(
      'madge output for apps/api is {"error":"boom"}; expected a JSON array of cycles'
    );
  });
});
