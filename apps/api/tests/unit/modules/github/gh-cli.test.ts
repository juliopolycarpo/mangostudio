import { describe, expect, it } from 'bun:test';
import {
  buildGhArgv,
  buildGhEnvironment,
  createGhCli,
  type GhCommandRunner,
} from '../../../../src/modules/github/infrastructure/gh-cli';

const success = { stdout: '', stderr: '', exitCode: 0 } as const;

describe('GitHub CLI adapter', () => {
  it('constructs only the read-only command allowlist', () => {
    expect(buildGhArgv(['--version'])).toEqual(['gh', '--version']);
    expect(buildGhArgv(['auth', 'status'])).toEqual(['gh', 'auth', 'status']);
    expect(() => buildGhArgv(['issue', 'list'])).toThrow('Unsupported GitHub CLI command');
    expect(() => buildGhArgv(['pr', 'view'])).toThrow('Unsupported GitHub CLI command');
  });

  it('keeps gh configuration while stripping token-bearing variables', () => {
    const environment = buildGhEnvironment({
      PATH: '/test/bin',
      HOME: '/test/home',
      GH_CONFIG_DIR: '/test/gh',
      GH_HOST: 'github.example',
      HTTPS_PROXY: 'https://proxy.example',
      GH_TOKEN: 'secret-gh-token',
      GITHUB_TOKEN: 'secret-actions-token',
      GH_ENTERPRISE_TOKEN: 'secret-enterprise-token',
    });

    expect(environment).toMatchObject({
      PATH: '/test/bin',
      HOME: '/test/home',
      GH_CONFIG_DIR: '/test/gh',
      GH_HOST: 'github.example',
      HTTPS_PROXY: 'https://proxy.example',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      LC_ALL: 'C',
    });
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('GH_ENTERPRISE_TOKEN');
  });

  it('uses exact JSON field lists through the typed facade', async () => {
    const commands: string[][] = [];
    const runner: GhCommandRunner = (args) => {
      commands.push([...args]);
      return Promise.resolve(success);
    };
    const cli = createGhCli({ runner });

    await cli.isAvailable('/repo');
    await cli.isAuthenticated('/repo');
    await cli.viewRepo('/repo');
    await cli.viewCurrentPr('/repo');

    expect(commands).toEqual([
      ['--version'],
      ['auth', 'status'],
      ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url'],
      ['pr', 'view', '--json', 'number,title,state,isDraft,url,headRefName,baseRefName'],
    ]);
  });

  it('caches authentication briefly and re-probes after the TTL', async () => {
    let now = 1_000;
    let authenticated = false;
    let authCalls = 0;
    const runner: GhCommandRunner = (args) => {
      if (args[0] !== 'auth') return Promise.resolve(success);
      authCalls += 1;
      return authenticated ? Promise.resolve(success) : Promise.reject(new Error('not logged in'));
    };
    const cli = createGhCli({ runner, now: () => now, authCacheTtlMs: 60_000 });

    expect(await cli.isAuthenticated('/repo')).toBe(false);
    authenticated = true;
    now += 59_999;
    expect(await cli.isAuthenticated('/repo')).toBe(false);
    expect(authCalls).toBe(1);

    now += 1;
    expect(await cli.isAuthenticated('/repo')).toBe(true);
    expect(authCalls).toBe(2);
  });

  it('single-flights concurrent authentication probes', async () => {
    let authCalls = 0;
    const runner: GhCommandRunner = async (args) => {
      if (args[0] === 'auth') {
        authCalls += 1;
        await Promise.resolve();
      }
      return success;
    };
    const cli = createGhCli({ runner });

    await Promise.all([
      cli.isAuthenticated('/repo'),
      cli.isAuthenticated('/repo'),
      cli.isAuthenticated('/repo'),
    ]);

    expect(authCalls).toBe(1);
  });
});
