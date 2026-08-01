import { describe, expect, it } from 'bun:test';
import { buildStdioEnv } from '../../../../src/services/mcp/stdio-env';

describe('buildStdioEnv', () => {
  it('never forwards secret-bearing process env to the child', () => {
    const env = buildStdioEnv(
      {},
      {
        PATH: '/usr/bin',
        BETTER_AUTH_SECRET: 'auth-secret',
        GEMINI_API_KEY_DEFAULT: 'provider-key',
        OPENAI_API_KEY: 'provider-key',
        AWS_ACCESS_KEY_ID: 'cloud-key',
        RANDOM_APP_VAR: 'not-allowlisted-either',
      }
    );

    expect(env.PATH).toBe('/usr/bin');
    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('forwards only allowlisted variables from the process env', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      MANGO_LOG_FILE: '/tmp/log',
    };
    if (process.platform !== 'win32') {
      source.HOME = '/home/user';
      source.LANG = 'en_US.UTF-8';
    }

    const env = buildStdioEnv({}, source);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.MANGO_LOG_FILE).toBeUndefined();
    if (process.platform !== 'win32') {
      expect(env.HOME).toBe('/home/user');
      expect(env.LANG).toBe('en_US.UTF-8');
    }
  });

  it('merges the server row env on top of inherited variables', () => {
    const env = buildStdioEnv({ PATH: '/custom/bin', MCP_FLAG: 'on' }, { PATH: '/usr/bin' });

    expect(env.PATH).toBe('/custom/bin');
    expect(env.MCP_FLAG).toBe('on');
  });

  it('skips exported shell functions', () => {
    const env = buildStdioEnv({}, { PATH: '() { :; }; echo pwned' });

    expect(env.PATH).toBeUndefined();
  });
});
