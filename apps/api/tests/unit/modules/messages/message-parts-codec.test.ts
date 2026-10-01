import { describe, expect, it } from 'bun:test';
import type { MessagePart } from '@mangostudio/shared/types';
import {
  decodeMessageParts,
  readMessageParts,
} from '../../../../src/modules/messages/infrastructure/message-parts-codec';

/** Named fake for the hub log: collects every structured line written to `console.warn`. */
class WarnCapture {
  readonly lines: string[] = [];
  private readonly original = console.warn;
  private readonly originalFlag = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;

  start(): void {
    // The test lanes silence diagnostic logs; this fake needs them on.
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    console.warn = (...args: unknown[]) => {
      this.lines.push(args.map(String).join(' '));
    };
  }

  stop(): void {
    console.warn = this.original;
    if (this.originalFlag === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = this.originalFlag;
  }
}

describe('decodeMessageParts', () => {
  it('reports a missing cell as absent', () => {
    expect(decodeMessageParts(null)).toEqual({ kind: 'absent' });
    expect(decodeMessageParts('')).toEqual({ kind: 'absent' });
  });

  it('keeps parts of an unknown or legacy type and parts with missing optional fields', () => {
    const parts = [
      { type: 'text', text: 'hi' },
      { type: 'future_widget', payload: { anything: 1 } },
      { type: 'tool_result', toolCallId: 'call-1', content: 'done' },
      { type: 'thinking', text: 'hmm' },
    ] as unknown as MessagePart[]; // an unknown type is not in the union by design

    expect(decodeMessageParts(JSON.stringify(parts))).toEqual({ kind: 'ok', parts });
  });

  it('treats an empty array as valid, not corrupt', () => {
    expect(decodeMessageParts('[]')).toEqual({ kind: 'ok', parts: [] });
  });

  it.each([
    ['a primitive', '[1]'],
    ['a nested array', '[[]]'],
    ['an object without a type', '[{"text":"x"}]'],
    ['an object with a non-string type', '[{"type":3}]'],
  ])('rejects an element that is %s', (_label, raw) => {
    expect(decodeMessageParts(raw)).toMatchObject({
      kind: 'corrupt',
      shape: { reason: 'invalid_element', elementIndex: 0 },
    });
  });

  it('returns the parts of a valid array', () => {
    const parts: MessagePart[] = [{ type: 'text', text: 'hi' }];

    expect(decodeMessageParts(JSON.stringify(parts))).toEqual({ kind: 'ok', parts });
  });

  it('describes unparsable text by shape only', () => {
    expect(decodeMessageParts('{not json')).toEqual({
      kind: 'corrupt',
      shape: { reason: 'invalid_json', bytes: 9, jsonType: 'unparsable' },
    });
  });

  it('describes valid JSON that is not an array', () => {
    expect(decodeMessageParts('{"type":"text"}')).toEqual({
      kind: 'corrupt',
      shape: { reason: 'not_an_array', bytes: 15, jsonType: 'object' },
    });
  });

  it('names the first array element that is not a message part', () => {
    const raw = JSON.stringify([{ type: 'text', text: 'ok' }, null]);

    expect(decodeMessageParts(raw)).toEqual({
      kind: 'corrupt',
      shape: { reason: 'invalid_element', bytes: raw.length, jsonType: 'array', elementIndex: 1 },
    });
  });
});

describe('readMessageParts', () => {
  it('degrades a corrupt cell to undefined and logs the message id, not the value', () => {
    const capture = new WarnCapture();
    capture.start();
    let parts: unknown;
    try {
      parts = readMessageParts({ id: 'msg-1', parts: '{secret-not-json' });
    } finally {
      capture.stop();
    }

    expect(parts).toBeUndefined();
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]).toContain('"messageId":"msg-1"');
    expect(capture.lines[0]).not.toContain('secret');
  });

  it('reports the same damaged cell once, not on every read', () => {
    const capture = new WarnCapture();
    capture.start();
    try {
      for (let read = 0; read < 3; read++) {
        readMessageParts({ id: 'msg-repeat', parts: '{not json' });
      }
      readMessageParts({ id: 'msg-other', parts: '{not json' });
    } finally {
      capture.stop();
    }

    expect(capture.lines).toHaveLength(2);
    expect(capture.lines[0]).toContain('"messageId":"msg-repeat"');
    expect(capture.lines[1]).toContain('"messageId":"msg-other"');
  });

  it('stays silent when told the row was already reported', () => {
    const capture = new WarnCapture();
    capture.start();
    try {
      readMessageParts({ id: 'msg-quiet', parts: '{not json' }, { quiet: true });
    } finally {
      capture.stop();
    }

    expect(capture.lines).toEqual([]);
  });

  it('returns valid parts without logging', () => {
    const capture = new WarnCapture();
    capture.start();
    let parts: unknown;
    try {
      parts = readMessageParts({ id: 'msg-1', parts: '[{"type":"text","text":"a"}]' });
    } finally {
      capture.stop();
    }

    expect(parts).toEqual([{ type: 'text', text: 'a' }]);
    expect(capture.lines).toEqual([]);
  });
});
