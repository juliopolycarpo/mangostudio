import { describe, expect, it } from 'bun:test';
import { buildHubServiceDefinition } from '../../../../src/modules/machine/application/hub-service';
import { hubServiceUnitName } from '../../../../src/modules/machine/domain/hub-service-identity';

describe('buildHubServiceDefinition', () => {
  it('forwards configuration, never secrets, and marks the unit', () => {
    const definition = buildHubServiceDefinition({
      executable: { argv: ['/opt/mangostudio'], pointer: 'external' },
      unitName: 'mangostudio.service',
      logFile: '/home/j/.mango/logs/service.log',
      env: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy:3128',
        BETTER_AUTH_SECRET: 'secret',
        GEMINI_API_KEY_DEFAULT: 'secret',
        DATABASE_PATH: '/tmp/db',
        MANGO_HOME: '',
      },
    });
    expect(definition.argv).toEqual(['/opt/mangostudio', 'serve']);
    expect(definition.env).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:3128',
      MANGO_LOG_FILE: '/home/j/.mango/logs/service.log',
      MANGOSTUDIO_SERVICE_UNIT: 'mangostudio.service',
    });
    expect(definition.workingDirectory).toBeUndefined();
    expect(definition.logFile).toBe('/home/j/.mango/logs/service.log');
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
      env: {},
      target: { port: 3000 },
    });
    expect(definition.argv).toEqual(['/usr/bin/bun', '/repo/cli.ts', 'serve']);
    expect(definition.workingDirectory).toBe('/repo');
    expect(definition.env).toMatchObject({ API_PORT: '3000' });
    expect(definition.env).not.toHaveProperty('API_HOST');
  });
});

describe('hubServiceUnitName', () => {
  it('names the unit the way each supervisor does', () => {
    expect(hubServiceUnitName('linux')).toBe('mangostudio.service');
    expect(hubServiceUnitName('darwin')).toBe('com.mangostudio.hub');
    expect(hubServiceUnitName('win32')).toBe('MangoStudio Hub');
  });
});
