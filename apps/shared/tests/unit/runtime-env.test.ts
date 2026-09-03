import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPathEnv,
  libraryPathEnvOverrides,
  MANGO_CONFIG_HOME_ENV,
  parseRuntimeEnvContent,
  parseRuntimeEnvFile,
  SKILLS_DIR_ENV,
} from '../../src/runtime-env';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mango-runtime-env-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

describe('createPathEnv', () => {
  it('builds a host layout the writers can take without throwing', () => {
    const env = createPathEnv({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { [SKILLS_DIR_ENV]: '/custom/skills' },
    });

    expect(env.homeDir).toBe('/home/tester');
    expect(env.env[SKILLS_DIR_ENV]).toBe('/custom/skills');
    expect(JSON.stringify(env)).not.toContain('LibraryPathEnv');
  });
});

describe('libraryPathEnvOverrides', () => {
  it('copies only the MangoStudio directory pins that are set', () => {
    expect(
      libraryPathEnvOverrides({
        PATH: '/bin',
        [SKILLS_DIR_ENV]: '/custom/skills',
        [MANGO_CONFIG_HOME_ENV]: '  ',
      })
    ).toEqual({ [SKILLS_DIR_ENV]: '/custom/skills' });
  });
});

describe('parseRuntimeEnvFile', () => {
  it('returns parsed values from an env file', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, 'API_HOST="127.0.0.1"\n');

    expect(parseRuntimeEnvFile(envPath)).toEqual({ API_HOST: '127.0.0.1' });
  });

  it('returns an empty map for missing or unreadable paths', () => {
    expect(parseRuntimeEnvFile(join(tmpDir, 'missing.env'))).toEqual({});
    expect(parseRuntimeEnvFile(tmpDir)).toEqual({});
  });
});
