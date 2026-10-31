import { describe, expect, it } from 'bun:test';

import {
  assertMachineStdoutLimit,
  createMachineStdoutCapture,
  MAX_MACHINE_STDOUT_LINE_BYTES,
} from '../lib/native-command-output';

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
