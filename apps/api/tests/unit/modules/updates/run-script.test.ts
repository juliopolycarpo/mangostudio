import { describe, expect, it } from 'bun:test';

import {
  pumpLines,
  runScript,
  SCRIPT_LINE_MAX_CHARS,
  type ScriptOutputLine,
} from '../../../../src/modules/updates/infrastructure/run-script';

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

/** A byte stream delivering `bytes` in pieces of the given sizes, then closing. */
function streamOf(bytes: Uint8Array, pieceSizes: Iterable<number>): ReadableStream<Uint8Array> {
  const sizes = pieceSizes[Symbol.iterator]();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const size = Math.max(1, sizes.next().value ?? 1);
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function pumped(
  bytes: Uint8Array,
  pieceSizes: Iterable<number>
): Promise<ScriptOutputLine['line'][]> {
  const lines: string[] = [];
  await pumpLines(streamOf(bytes, pieceSizes), 'stdout', (entry) => lines.push(entry.line));
  return lines;
}

/** What the relay must emit for a stream: split at `\n`, drop one trailing `\r` per line, skip an empty tail. */
function expectedLines(text: string): string[] {
  const lines = text.split('\n');
  const tail = lines.pop() ?? '';
  if (tail.length > 0) lines.push(tail);
  return lines.map((line) => line.replace(/\r$/, ''));
}

function* repeating(...sizes: number[]): Generator<number> {
  for (;;) for (const size of sizes) yield size;
}

describe('pumpLines', () => {
  it('relays the same lines as splitting the whole output, for any read sizes', async () => {
    const encoder = new TextEncoder();
    const output = 'one\r\ntwo\n\nthree 🥭 é\r\nprogress 10%\rprogress 20%\r\n\r\nlast 中文';
    const bytes = encoder.encode(output);

    for (const sizes of [[1], [2], [3], [5], [7, 1], [bytes.byteLength]]) {
      expect({ sizes, lines: await pumped(bytes, repeating(...sizes)) }).toEqual({
        sizes,
        lines: expectedLines(output),
      });
    }
  });

  it('emits nothing for empty output and no empty line for a trailing newline', async () => {
    const encoder = new TextEncoder();

    expect(await pumped(encoder.encode(''), [1])).toEqual([]);
    expect(await pumped(encoder.encode('a\n'), [1])).toEqual(['a']);
  });

  it('cuts a line over the cap to the cap and resumes at the next newline', async () => {
    const encoder = new TextEncoder();
    const long = 'x'.repeat(SCRIPT_LINE_MAX_CHARS + 10);

    const lines = await pumped(encoder.encode(`${long}\nafter\n`), repeating(4096));

    expect(lines).toEqual(['x'.repeat(SCRIPT_LINE_MAX_CHARS), 'after']);
  });

  it('keeps a line of exactly the cap whole', async () => {
    const encoder = new TextEncoder();
    const exact = 'y'.repeat(SCRIPT_LINE_MAX_CHARS);

    expect(await pumped(encoder.encode(`${exact}\n`), repeating(4096))).toEqual([exact]);
  });

  // The relay used to append each read to one string and search it again, so
  // a line spanning n reads cost O(line * n): 1 MiB in 16-byte reads took
  // several seconds. The bound separates linear from quadratic; it is no benchmark.
  it.each([
    ['a newline-terminated line', `${'a'.repeat(1024 * 1024)}\n`],
    ['`\\r` progress that never ends in a newline', 'progress 42%\r'.repeat(80_000)],
  ])('reads %s of about 1 MiB in 16-byte reads within 1500 ms', async (_name, output) => {
    const bytes = new TextEncoder().encode(output);

    const startedAt = performance.now();
    const lines = await pumped(bytes, repeating(16));
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1500);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBe(SCRIPT_LINE_MAX_CHARS);
  });
});
