import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getLibraryTarget } from '@mangostudio/shared/library/host';
import { createPathEnv } from '@mangostudio/shared/runtime-env';
import { getConfig, TEST_MANAGED_CONFIG_DIR } from '../../../../src/lib/config';
import {
  configuredLibraryEnv,
  createLibraryPathEnv,
  describeLocation,
  hubLibraryEnvFor,
  hubLibraryPathEnvParams,
} from '../../../../src/modules/library/infrastructure/location-probe';

describe('hubLibraryPathEnvParams', () => {
  it('pins configured MangoStudio directories only for the hub machine', () => {
    const configured = configuredLibraryEnv();
    expect(hubLibraryEnvFor(LOCAL_ENVIRONMENT_ID)).toEqual(configured);
    expect(hubLibraryPathEnvParams(LOCAL_ENVIRONMENT_ID)?.env).toEqual(configured);
    expect(hubLibraryEnvFor('ubuntu')).toBeUndefined();
    expect(hubLibraryPathEnvParams('ubuntu')).toBeUndefined();
  });

  it('lets a PathEnv override win on the hub machine and still omits it remotely', () => {
    const env = createPathEnv({
      platform: 'linux',
      homeDir: '/tmp/home',
      env: { SKILLS_DIR: '/custom/skills' },
    });

    expect(hubLibraryPathEnvParams(LOCAL_ENVIRONMENT_ID, env)?.env?.SKILLS_DIR).toBe(
      '/custom/skills'
    );
    expect(hubLibraryPathEnvParams('ubuntu', env)).toBeUndefined();
  });

  it('forwards workspaceRoot without sending hub directories to a remote machine', () => {
    expect(hubLibraryPathEnvParams('ubuntu', { env: {}, workspaceRoot: '/ws' })).toEqual({
      workspaceRoot: '/ws',
    });
  });
});

describe('configured MangoStudio paths under the test config home', () => {
  it('makes configHome and mango-* locations agree', () => {
    const env = createLibraryPathEnv();
    const config = getConfig();
    const configHome = dirname(config.configFilePath);

    expect(configHome).toBe(TEST_MANAGED_CONFIG_DIR);
    expect(getLibraryTarget('mangostudio')?.resolveConfigHome(env)).toBe(configHome);
    expect(describeLocation('mango-skills', env).path).toBe(config.skills.dir);
    expect(describeLocation('mango-agents', env).path).toBe(config.agents.dir);
    expect(describeLocation('mango-instructions', env).path).toBe(join(configHome, 'AGENTS.md'));
    expect(describeLocation('mango-settings', env).path).toBe(join(configHome, 'config.toml'));
    expect(config.skills.dir).toBe(join(configHome, 'skills'));
    expect(config.agents.dir).toBe(join(configHome, 'agents'));
  });
});
