import { describe, expect, test } from 'bun:test';
import { delimiter, resolve } from 'node:path';

import {
  artifactSmokeEnvironment,
  awaitSmokeCompletion,
  canExecuteArtifact,
  type SmokeProcessControl,
  stopSmokeProcess,
} from '../lib/binary-smoke-process';

/** A hub whose descendant can remain alive after its leader settles. */
class FakeSmokeProcess implements SmokeProcessControl {
  readonly signals: string[] = [];
  exitCode: number | null = null;
  descendant = true;
  private readonly completion = Promise.withResolvers<number>();
  readonly exited = this.completion.promise;
  constructor(
    private readonly mode: 'graceful' | 'leaked-child' | 'stuck' | 'nonzero' | 'census-error'
  ) {}
  alive(): Promise<boolean> {
    return this.mode === 'census-error'
      ? Promise.reject(new Error('census denied'))
      : Promise.resolve(this.descendant);
  }
  signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    this.signals.push(signal);
    if (signal === 'SIGTERM') {
      this.exitCode = this.mode === 'nonzero' ? 4 : 0;
      this.completion.resolve(this.exitCode);
      if (this.mode === 'graceful' || this.mode === 'nonzero') this.descendant = false;
    } else if (this.mode !== 'stuck') this.descendant = false;
    return Promise.resolve();
  }
}

describe('artifact process lifetime', () => {
  test('matches native host libc and rejects foreign/unknown platforms', () => {
    expect(canExecuteArtifact('linux-x64-musl', 'linux-x64-musl')).toBe(true);
    expect(canExecuteArtifact('linux-x64-musl', 'linux-x64')).toBe(false);
    expect(canExecuteArtifact('linux-x64', 'linux-x64-musl')).toBe(false);
    expect(canExecuteArtifact('windows-arm64', 'windows-x64')).toBe(false);
    expect(canExecuteArtifact('darwin-arm64', null)).toBe(false);
  });
  test('waits for graceful exit and descendant settlement', async () => {
    const child = new FakeSmokeProcess('graceful');
    await stopSmokeProcess(child, { graceMs: 20, killMs: 20, platform: 'linux' });
    expect(child.signals).toEqual(['SIGTERM']);
  });
  test('an exited parent with a surviving child requires cleanup and fails', async () => {
    const child = new FakeSmokeProcess('leaked-child');
    await expect(stopSmokeProcess(child, { graceMs: 10, killMs: 20 })).rejects.toThrow(
      'received SIGKILL, settled=true'
    );
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.descendant).toBe(false);
  });
  test('a census failure still attempts forced cleanup and reports settlement unproven', async () => {
    const child = new FakeSmokeProcess('census-error');
    await expect(stopSmokeProcess(child, { graceMs: 10, killMs: 10 })).rejects.toThrow(
      'census denied'
    );
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
  test('names an unsettled forced child instead of hanging', async () => {
    const child = new FakeSmokeProcess('stuck');
    await expect(stopSmokeProcess(child, { graceMs: 10, killMs: 10 })).rejects.toThrow(
      'settled=false'
    );
  });
  test('rejects nonzero POSIX exit but permits Windows termination semantics', async () => {
    await expect(
      stopSmokeProcess(new FakeSmokeProcess('nonzero'), { platform: 'linux' })
    ).rejects.toThrow('expected graceful exit 0 | received 4');
    await stopSmokeProcess(new FakeSmokeProcess('nonzero'), { platform: 'win32' });
    await stopSmokeProcess(new FakeSmokeProcess('nonzero'), {
      platform: 'linux',
      requireExitZero: false,
    });
  });
  test('drops developer configuration and checkout PATH while setting all isolated homes', () => {
    const checkout = resolve('checkout');
    const home = resolve('isolated-home');
    const env = artifactSmokeEnvironment(
      {
        PATH: [resolve('system-bin'), resolve(checkout, 'node_modules/.bin')].join(delimiter),
        SystemRoot: 'os',
        BETTER_AUTH_SECRET: 'private',
        MANGOSTUDIO_RUNTIME_BINARY: 'checkout-runtime',
        NODE_ENV: 'test',
      },
      home,
      checkout
    );
    expect(env.PATH).toBe(resolve('system-bin'));
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.MANGOSTUDIO_RUNTIME_BINARY).toBeUndefined();
    expect(env.NODE_ENV).toBe('production');
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    expect(env.MANGO_HOME).toBe(home);
    expect(env.SystemRoot).toBe('os');
    expect(env.MANGO_ENV_INSTALLS_ENABLED).toBe('0');
    expect(env.XDG_CONFIG_HOME).toBe(resolve(home, 'config'));
    expect(env.XDG_DATA_HOME).toBe(resolve(home, 'data'));
    expect(env.XDG_CACHE_HOME).toBe(resolve(home, 'cache'));
  });
});

test('owned completion resolves or names a bounded settlement failure', async () => {
  expect(await awaitSmokeCompletion(Promise.resolve('done'), 20, 'output')).toBe('done');
  await expect(
    awaitSmokeCompletion(Promise.reject(new Error('read failed')), 20, 'output')
  ).rejects.toThrow('read failed');
  await expect(awaitSmokeCompletion(new Promise(() => {}), 10, 'output')).rejects.toThrow(
    'output: expected settlement within 10ms'
  );
});
