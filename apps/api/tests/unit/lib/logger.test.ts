import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createDiagnosticLogger, logDiagnostic } from '../../../src/lib/logger';

type CapturedEntry = Record<string, unknown> & { metadata: Record<string, unknown> };

function captureConsole(method: 'warn' | 'error'): CapturedEntry[] {
  const entries: CapturedEntry[] = [];
  spyOn(console, method).mockImplementation((line: string) => {
    entries.push(JSON.parse(line) as CapturedEntry);
  });
  return entries;
}

describe('logger', () => {
  let previousLogSetting: string | undefined;

  beforeEach(() => {
    previousLogSetting = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
  });

  afterEach(() => {
    mock.restore();
    if (previousLogSetting === undefined) {
      delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
      return;
    }
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = previousLogSetting;
  });

  it('suppresses diagnostic logs when disabled', () => {
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '0';
    const entries = captureConsole('warn');

    logDiagnostic('warn', 'request', 'received', { method: 'GET' });

    expect(entries).toHaveLength(0);
  });

  it('emits a structured JSON diagnostic log when enabled', () => {
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    const entries = captureConsole('warn');

    createDiagnosticLogger('auth-plugin').info('request', {
      method: 'POST',
      path: '/auth/sign-in/email',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      scope: 'auth-plugin',
      event: 'request',
      metadata: { method: 'POST', path: '/auth/sign-in/email' },
    });
    expect(entries[0].ts).toBeGreaterThan(0);
  });

  it('normalizes Error and bigint metadata into JSON-safe values', () => {
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    const entries = captureConsole('error');

    logDiagnostic('error', 'serializers', 'invalid_style_params_json', {
      error: new SyntaxError('bad json'),
      size: 12n,
    });

    expect(entries[0].metadata).toMatchObject({
      error: { name: 'SyntaxError', message: 'bad json' },
      size: '12',
    });
  });
});
