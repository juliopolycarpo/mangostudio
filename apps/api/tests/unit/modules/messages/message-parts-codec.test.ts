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

  it('stays silent when told the row was already reported', () => {
    const capture = new WarnCapture();
    capture.start();
    try {
      readMessageParts({ id: 'msg-1', parts: '{not json' }, { quiet: true });
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
