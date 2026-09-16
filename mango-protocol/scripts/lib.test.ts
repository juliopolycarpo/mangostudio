import { describe, expect, it } from 'bun:test';
import { resolveArgv, runTask, task } from './lib';

describe('resolveArgv', () => {
  it('runs bun through the current binary', () => {
    expect(resolveArgv(['bun', 'test'])).toEqual([process.execPath, 'test']);
  });

  it('runs bunx as bun x through the current binary', () => {
    expect(resolveArgv(['bunx', 'biome', 'check'])).toEqual([
      process.execPath,
      'x',
      'biome',
      'check',
    ]);
  });

  it('resolves other commands on PATH and leaves unknown ones untouched', () => {
    const [resolved] = resolveArgv(['node', '--version']);
    const which = Bun.which('node');
    expect(resolved).toBe(which ?? 'node');
    expect(resolveArgv(['no-such-command-here', 'x'])).toEqual(['no-such-command-here', 'x']);
  });
});

describe('task', () => {
  it('omits cwd when none is given', () => {
    expect(task('name', ['bun', 'test'])).toEqual({ name: 'name', argv: ['bun', 'test'] });
    expect(task('name', ['bun'], '/tmp')).toEqual({ name: 'name', argv: ['bun'], cwd: '/tmp' });
  });

  it('omits env when none is given, and carries it when given', () => {
    expect(task('name', ['bun'])).toEqual({ name: 'name', argv: ['bun'] });
    expect(task('name', ['bun'], undefined, { RUSTDOCFLAGS: '-D warnings' })).toEqual({
      name: 'name',
      argv: ['bun'],
      env: { RUSTDOCFLAGS: '-D warnings' },
    });
  });
});

describe('runTask', () => {
  it('passes env through to the child, and only when given', async () => {
    const probe = ['bun', '-e', 'process.exit(process.env.MARKER === "set" ? 0 : 1)'];
    expect((await runTask(task('with', probe, undefined, { MARKER: 'set' }))).ok).toBe(true);
    expect((await runTask(task('without', probe))).ok).toBe(false);
  });
});
