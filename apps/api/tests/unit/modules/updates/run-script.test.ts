import { describe, expect, it } from 'bun:test';
import { runScript } from '../../../../src/modules/updates/infrastructure/run-script';

async function collect(argv: string[], env: Record<string, string> = {}) {
  const run = runScript(argv, { env: { PATH: process.env.PATH ?? '', ...env } });
  const lines: { stream: string; line: string }[] = [];
  for await (const line of run.lines) lines.push(line);
  const exitCode = await run.exitCode;
  return { lines, exitCode };
}

describe('runScript', () => {
  it('relays stdout lines verbatim and reports a zero exit', async () => {
    const { lines, exitCode } = await collect(['sh', '-c', 'echo one; echo two']);

    expect(lines).toEqual([
      { stream: 'stdout', line: 'one' },
      { stream: 'stdout', line: 'two' },
    ]);
    expect(exitCode).toBe(0);
  });

  it('tags stderr lines separately from stdout', async () => {
    const { lines, exitCode } = await collect(['sh', '-c', 'echo out; echo err >&2']);

    expect(lines).toContainEqual({ stream: 'stdout', line: 'out' });
    expect(lines).toContainEqual({ stream: 'stderr', line: 'err' });
    expect(exitCode).toBe(0);
  });

  it('reports the process exit code', async () => {
    const { exitCode } = await collect(['sh', '-c', 'exit 3']);

    expect(exitCode).toBe(3);
  });

  it('relays a trailing line with no terminating newline', async () => {
    const { lines } = await collect(['sh', '-c', 'printf %s no-newline']);

    expect(lines).toEqual([{ stream: 'stdout', line: 'no-newline' }]);
  });

  it('carries the env it was given through to the child', async () => {
    const { lines } = await collect(['sh', '-c', 'echo "$UPGRADE_PROBE"'], {
      UPGRADE_PROBE: 'from-engine',
    });

    expect(lines).toEqual([{ stream: 'stdout', line: 'from-engine' }]);
  });

  it('reports exit 127 with the failure reason when the program is not on PATH', async () => {
    const { lines, exitCode } = await collect(['mangostudio-definitely-not-a-real-binary']);

    expect(exitCode).toBe(127);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.stream).toBe('stderr');
    expect(lines[0]?.line).toContain('mangostudio-definitely-not-a-real-binary');
  });
});
