import { describe, expect, it } from 'bun:test';

import { countCircularDeps } from './circular';

/** Named fake of madge: cycles per root, recording which roots were asked. */
const makeFakeMadge = (cyclesByRoot: Readonly<Record<string, unknown>>) => {
  const roots: string[] = [];
  const run = (cmd: readonly string[]) => {
    const root = cmd.at(-1) ?? '';
    roots.push(root);
    return Promise.resolve({ stdout: JSON.stringify(cyclesByRoot[root] ?? []) });
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

  it('treats empty madge output as no cycles', async () => {
    expect(await countCircularDeps(['apps/api'], () => Promise.resolve({ stdout: '  ' }))).toBe(0);
  });

  it('rejects output that is not a list of cycles, naming the root and value', async () => {
    const run = () => Promise.resolve({ stdout: '{"error":"boom"}' });

    await expect(countCircularDeps(['apps/api'], run)).rejects.toThrow(
      'madge output for apps/api is {"error":"boom"}; expected a JSON array of cycles'
    );
  });
});
