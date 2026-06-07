import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRuntimeEnvContent, parseRuntimeEnvFile } from '../../src/runtime-env';

const TMP_DIR = join(tmpdir(), `mango-runtime-env-test-${process.pid}`);

describe('parseRuntimeEnvContent', () => {
  it('parses simple KEY=value lines', () => {
    expect(parseRuntimeEnvContent('API_HOST=localhost\nAPI_PORT=3001')).toEqual({
      API_HOST: 'localhost',
      API_PORT: '3001',
    });
  });

  it('ignores blank lines, comments, malformed lines, and empty keys', () => {
    const parsed = parseRuntimeEnvContent('\n# comment\nMALFORMED\n=value\nAPI_PORT=3001\n');

    expect(parsed).toEqual({ API_PORT: '3001' });
  });

  it('strips matching single or double quotes', () => {
    const parsed = parseRuntimeEnvContent(
      'DOUBLE_QUOTED="double value"\nSINGLE_QUOTED=\'single value\'\n'
    );

    expect(parsed).toEqual({
      DOUBLE_QUOTED: 'double value',
      SINGLE_QUOTED: 'single value',
    });
  });

  it('preserves unmatched quotes and additional equals signs in values', () => {
    const parsed = parseRuntimeEnvContent('TOKEN="unterminated\nDATABASE_URL=a=b=c\n');

    expect(parsed).toEqual({
      TOKEN: '"unterminated',
      DATABASE_URL: 'a=b=c',
    });
  });
});

describe('parseRuntimeEnvFile', () => {
  it('returns parsed values from an env file', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const envPath = join(TMP_DIR, '.env');
    writeFileSync(envPath, 'API_HOST="127.0.0.1"\n');

    try {
      expect(parseRuntimeEnvFile(envPath)).toEqual({ API_HOST: '127.0.0.1' });
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  it('returns an empty map for missing or unreadable paths', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    try {
      expect(parseRuntimeEnvFile(join(TMP_DIR, 'missing.env'))).toEqual({});
      expect(parseRuntimeEnvFile(TMP_DIR)).toEqual({});
    } finally {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });
});
