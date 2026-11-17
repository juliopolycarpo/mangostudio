import { describe, expect, it } from 'bun:test';

import {
  assertMachineStdoutLimit,
  createMachineStdoutCapture,
  createTextLineTee,
  MAX_MACHINE_STDOUT_LINE_BYTES,
} from '../lib/native-command-output';
import { countScanWork } from './support/scan-work';

class FakeMachineOutputSink {
  readonly chunks: string[] = [];
  readonly errors: string[] = [];
  readonly write = (text: string): void => {
    this.chunks.push(text);
  };
  readonly report = (message: string): void => {
    this.errors.push(message);
  };
}
describe('bounded machine stdout', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_MACHINE_STDOUT_LINE_BYTES + 1])(
    'rejects invalid byte budget %s',
    (value) => {
      expect(() => assertMachineStdoutLimit(value)).toThrow('expected a positive safe integer');
    }
  );
  it('accepts a finite budget through the hard ceiling', () => {
    expect(() => assertMachineStdoutLimit(1)).not.toThrow();
    expect(() => assertMachineStdoutLimit(MAX_MACHINE_STDOUT_LINE_BYTES)).not.toThrow();
  });
  it('counts UTF-8 bytes across split code points and preserves original decoded text', () => {
    const sink = new FakeMachineOutputSink();
    const capture = createMachineStdoutCapture(2, sink.write, sink.report);
    capture.write(Buffer.from([0xc3]));
    capture.write(Buffer.from([0xa9, 0x0a]));
    capture.end();
    expect(sink.chunks.join('')).toBe('é\n');
    expect(sink.errors).toEqual([]);
  });
  it('enforces complete single-chunk lines and resets the budget for each newline', () => {
    const sink = new FakeMachineOutputSink();
    const capture = createMachineStdoutCapture(2, sink.write, sink.report);
    capture.write(Buffer.from('abc\nx\nxyz\n'));
    capture.end();
    expect(sink.chunks.join('')).toBe('abc\nx\nxyz\n');
    expect(sink.errors).toHaveLength(2);
    expect(sink.errors[0]).toContain('expected <= 2 UTF-8 bytes | received: 3');
  });
  it('reports a chunked oversized line once and preserves a final line without LF', () => {
    const sink = new FakeMachineOutputSink();
    const capture = createMachineStdoutCapture(2, sink.write, sink.report);
    capture.write(Buffer.from('ab'));
    capture.write(Buffer.from('cd'));
    capture.write(Buffer.from('ef'));
    capture.end();
    expect(sink.chunks.join('')).toBe('abcdef');
    expect(sink.errors).toHaveLength(1);
  });
});

/**
 * The loop `runNativeCommand` used before `createTextLineTee`, kept as the
 * reference: it rescans the pending text on every write, which is the cost the
 * tee removes, and its output is what the tee must still produce.
 */
function oldPendingLoop(
  chunks: readonly string[],
  maxLineChars: number
): { readonly output: string[]; readonly reportedLengths: number[] } {
  const output: string[] = [];
  const reportedLengths: number[] = [];
  let pending = '';
  for (const chunk of chunks) {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      output.push(pending.slice(0, newline + 1));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
    if (pending.length > maxLineChars) {
      reportedLengths.push(pending.length);
      output.push(`${pending}\n`);
      pending = '';
    }
  }
  if (pending) output.push(`${pending}\n`);
  return { output, reportedLengths };
}

function runTextLineTee(
  chunks: readonly string[],
  maxLineChars: number
): { readonly output: string; readonly errors: string[] } {
  const sink = new FakeMachineOutputSink();
  const tee = createTextLineTee(sink.write, sink.report, maxLineChars);
  for (const chunk of chunks) tee.write(chunk);
  tee.end();
  return { output: sink.chunks.join(''), errors: sink.errors };
}

describe('text line tee', () => {
  it('writes complete lines whole and ends a final partial line with a newline', () => {
    const sink = new FakeMachineOutputSink();
    const tee = createTextLineTee(sink.write, sink.report);

    tee.write('one\ntw');
    tee.write('o\nthr');
    tee.write('ee');
    tee.end();

    expect(sink.chunks).toEqual(['one\n', 'two\n', 'three\n']);
    expect(sink.errors).toEqual([]);
  });

  it('writes nothing for a stream that never wrote', () => {
    const sink = new FakeMachineOutputSink();
    const tee = createTextLineTee(sink.write, sink.report);

    tee.write('');
    tee.end();

    expect(sink.chunks).toEqual([]);
  });

  it('writes what the old pending loop wrote, for every chunking of random text', () => {
    // A seeded generator, so a failing case names the seed that reproduces it.
    let state = 0x5eed;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const alphabet = ['a', 'b', '\n', '\n', '\r', 'é'];
    for (let seed = 0; seed < 400; seed += 1) {
      let text = '';
      for (let at = Math.floor(next() * 50); at > 0; at -= 1) {
        text += alphabet[Math.floor(next() * alphabet.length)];
      }
      const maxLineChars = [3, 8, 1000][seed % 3] ?? 3;
      const maxPiece = 1 + (seed % 7);
      const chunks: string[] = [];
      for (let offset = 0; offset < text.length;) {
        const size = Math.ceil(next() * maxPiece);
        chunks.push(text.slice(offset, offset + size));
        offset += size;
      }

      const received = runTextLineTee(chunks, maxLineChars);
      const reference = oldPendingLoop(chunks, maxLineChars);

      expect({ seed, chunks, output: received.output }).toEqual({
        seed,
        chunks,
        output: reference.output.join(''),
      });
      expect({ seed, chunks, errors: received.errors.length }).toEqual({
        seed,
        chunks,
        errors: reference.reportedLengths.length,
      });
    }
  });

  it('reports a line over the limit once, with its length and the limit, and keeps its text', () => {
    const received = runTextLineTee(['abcd', 'efgh', 'ijkl', '\nnext'], 10);

    expect(received.errors).toEqual([
      'Output line of 12 characters exceeds the 10-character limit; expected bounded text reporter lines',
    ]);
    // The flush ends the line itself, so the newline that really ends it follows as an empty line.
    expect(received.output).toBe('abcdefghijkl\n\nnext\n');
  });

  it('does not report a line of exactly the limit', () => {
    const received = runTextLineTee(['a'.repeat(10), '\n'], 10);

    expect(received.errors).toEqual([]);
    expect(received.output).toBe(`${'a'.repeat(10)}\n`);
  });

  // The loop used to search the whole pending text on every write; with the
  // limit at 1 MiB, a 1 MiB line in 16-byte writes searched about 3e10 units.
  // Counted, not timed.
  it('passes a 1 MiB line written in 16-character pieces by searching it once', () => {
    const text = `${'a'.repeat(1_048_576)}\n`;
    const sink = new FakeMachineOutputSink();
    const tee = createTextLineTee(sink.write, sink.report);

    const units = countScanWork(() => {
      for (let offset = 0; offset < text.length; offset += 16) {
        tee.write(text.slice(offset, offset + 16));
      }
      tee.end();
    });

    expect(sink.chunks.map((chunk) => chunk.length)).toEqual([1_048_577]);
    expect(sink.errors).toEqual([]);
    expect(units).toBeLessThanOrEqual(3 * text.length);
  });
});
