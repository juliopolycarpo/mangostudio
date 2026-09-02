import { describe, expect, it } from 'bun:test';
import {
  buildHubServiceDefinition,
  withoutUserinfo,
} from '../../../../src/modules/machine/application/hub-service';
import { hubServiceUnitName } from '../../../../src/modules/machine/domain/hub-service-identity';

describe('buildHubServiceDefinition', () => {
  it('forwards configuration, never secrets, and marks the unit', () => {
    const definition = buildHubServiceDefinition({
      executable: { argv: ['/opt/mangostudio'], pointer: 'external' },
      unitName: 'mangostudio.service',
      logFile: '/home/j/.mango/logs/service.log',
      platform: 'linux',
      env: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://alice:hunter2@proxy:3128',
        BETTER_AUTH_SECRET: 'secret',
        GEMINI_API_KEY_DEFAULT: 'secret',
        DATABASE_PATH: '/tmp/db',
        MANGO_HOME: '',
      },
    });
    expect(definition.argv).toEqual(['/opt/mangostudio', 'serve']);
    expect(definition.env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:3128/',
      // Configuration this hub is running on, which the unit replacing it has
      // to run on too — see the handover test below.
      DATABASE_PATH: '/tmp/db',
      MANGO_LOG_FILE: '/home/j/.mango/logs/service.log',
      MANGOSTUDIO_SERVICE_UNIT: 'mangostudio.service',
    });
    expect(definition.workingDirectory).toBeUndefined();
    expect(definition.logFile).toBe('/home/j/.mango/logs/service.log');
  });

  it('carries every runtime-configuration key the hub was started with', () => {
    // A hub configured entirely through its environment, with no config.toml
    // and no .env: installing a unit stops this process and starts one from
    // the unit file, so anything the unit file does not say is a default.
    const definition = buildHubServiceDefinition({
      executable: { argv: ['/opt/mangostudio'], pointer: 'external' },
      unitName: 'mangostudio.service',
      logFile: '/home/j/.mango/logs/service.log',
      platform: 'linux',
      env: {
        DATABASE_PATH: '/srv/mango/database.sqlite',
        UPLOADS_DIR: '/srv/mango/uploads',
        PUBLIC_URL: 'https://mango.example',
        ALLOWED_ORIGINS: 'https://mango.example',
        TRUST_PROXY: 'true',
      },
    });

    expect(definition.env).toMatchObject({
      DATABASE_PATH: '/srv/mango/database.sqlite',
      UPLOADS_DIR: '/srv/mango/uploads',
      PUBLIC_URL: 'https://mango.example',
      ALLOWED_ORIGINS: 'https://mango.example',
      TRUST_PROXY: 'true',
    });
  });

  it('leaves the auth secret out even though it configures the hub', () => {
    const definition = buildHubServiceDefinition({
      executable: { argv: ['/opt/mangostudio'], pointer: 'external' },
      unitName: 'mangostudio.service',
      logFile: '/x.log',
      platform: 'linux',
      env: { BETTER_AUTH_SECRET: 'hunter2', BETTER_AUTH_URL: 'https://mango.example' },
    });

    // A unit file is not where a secret goes; `service install` refuses while
    // the secret lives nowhere a unit can read it instead.
    expect(definition.env).not.toHaveProperty('BETTER_AUTH_SECRET');
    expect(definition.env).toMatchObject({ BETTER_AUTH_URL: 'https://mango.example' });
  });

  it('lets an explicit bind target win over the environment it inherited', () => {
    const definition = buildHubServiceDefinition({
      executable: { argv: ['/opt/mangostudio'], pointer: 'external' },
      unitName: 'mangostudio.service',
      logFile: '/x.log',
      platform: 'linux',
      env: { API_PORT: '3000', API_HOST: '127.0.0.1' },
      target: { port: 4000, host: '0.0.0.0' },
    });

    expect(definition.env).toMatchObject({ API_PORT: '4000', API_HOST: '0.0.0.0' });
  });

  it('keeps the checkout as working directory for a source install', () => {
    const definition = buildHubServiceDefinition({
      executable: {
        argv: ['/usr/bin/bun', '/repo/cli.ts'],
        workingDirectory: '/repo',
        pointer: 'source',
      },
      unitName: 'com.mangostudio.hub',
      logFile: '/x.log',
      platform: 'linux',
      env: {},
      target: { port: 3000 },
    });
    expect(definition.argv).toEqual(['/usr/bin/bun', '/repo/cli.ts', 'serve']);
    expect(definition.workingDirectory).toBe('/repo');
    expect(definition.env).toMatchObject({ API_PORT: '3000' });
    expect(definition.env).not.toHaveProperty('API_HOST');
  });
});

describe('buildHubServiceDefinition on Windows', () => {
  it('leaves PATH to the logon session instead of inlining it into the task', () => {
    const definition = buildHubServiceDefinition({
      executable: { argv: ['C:\\x\\mangostudio.cmd'], pointer: 'current' },
      unitName: 'MangoStudio Hub',
      logFile: 'C:\\x\\service.log',
      platform: 'win32',
      env: { PATH: 'C:\\very\\long', TZ: 'UTC' },
    });
    expect(definition.env).not.toHaveProperty('PATH');
    expect(definition.env).toMatchObject({ TZ: 'UTC' });
  });
});

describe('withoutUserinfo', () => {
  it('strips credentials and leaves everything else alone', () => {
    expect(withoutUserinfo('http://alice:hunter2@proxy:3128')).toBe('http://proxy:3128/');
    expect(withoutUserinfo('http://proxy:3128')).toBe('http://proxy:3128');
    expect(withoutUserinfo('not a url')).toBe('not a url');
  });
});

describe('hubServiceUnitName', () => {
  it('names the unit the way each supervisor does', () => {
    expect(hubServiceUnitName('linux')).toBe('mangostudio.service');
    expect(hubServiceUnitName('darwin')).toBe('com.mangostudio.hub');
    expect(hubServiceUnitName('win32')).toBe('MangoStudio Hub');
  });
});
