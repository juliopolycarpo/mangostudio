import { describe, expect, it } from 'bun:test';
import {
  appendBoundedTail,
  CURSOR_SIDECAR_PROTOCOL_VERSION,
  describeCursorSpawnError,
} from '../../../../../src/services/providers/cursor/sidecar-process';

describe('appendBoundedTail', () => {
  it('appends below the cap without truncation', () => {
    expect(appendBoundedTail('abc', 'def', 10)).toBe('abcdef');
  });

  it('keeps only the tail once the cap is exceeded', () => {
    expect(appendBoundedTail('abcdef', 'ghij', 6)).toBe('efghij');
  });

  it('bounds a single oversized chunk', () => {
    expect(appendBoundedTail('', 'x'.repeat(100), 8)).toBe('x'.repeat(8));
  });

  it('never grows past the cap across many chunks', () => {
    let buffer = '';
    for (let i = 0; i < 1_000; i += 1) {
      buffer = appendBoundedTail(buffer, `line-${i}\n`, 64);
      expect(buffer.length).toBeLessThanOrEqual(64);
    }
    expect(buffer.endsWith('line-999\n')).toBe(true);
  });
});

describe('describeCursorSpawnError', () => {
  it('maps ENOENT to the node-not-found runtime hint', () => {
    const message = describeCursorSpawnError(
      Object.assign(new Error('spawn /usr/bin/node ENOENT'), { code: 'ENOENT' }),
      '/usr/bin/node'
    );
    expect(message).toContain('NodeJS installed');
  });

  it('maps EACCES to the node-invalid hint including the binary path', () => {
    const message = describeCursorSpawnError(
      Object.assign(new Error('spawn /opt/node EACCES'), { code: 'EACCES' }),
      '/opt/node'
    );
    expect(message).toContain('/opt/node');
    expect(message).toContain('not runnable');
  });

  it('falls back to the raw error message for unknown codes', () => {
    const message = describeCursorSpawnError(new Error('boom'), '/usr/bin/node');
    expect(message).toBe('boom');
  });
});

describe('protocol version', () => {
  it('is a positive integer shared with sidecar/run-agent.mjs', () => {
    expect(Number.isInteger(CURSOR_SIDECAR_PROTOCOL_VERSION)).toBe(true);
    expect(CURSOR_SIDECAR_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
