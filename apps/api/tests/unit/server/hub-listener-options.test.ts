import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../../../src/app';
import { hubListenOptions } from '../../../src/lib/hub-connection-limits';
import { listenOrExit } from '../../../src/server/start-server';
import { scanSourcePaths } from '../../support/source-scan';

const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));

const listenSpies: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of listenSpies.splice(0)) spy.mockRestore();
});

describe('the hub listener', () => {
  it('binds the real app with the options the SSE keepalive is sized for', () => {
    const listen = spyOn(app, 'listen').mockImplementation(() => app);
    listenSpies.push(listen);

    listenOrExit(4321, '127.0.0.1');

    expect(listen.mock.calls).toEqual([[hubListenOptions('127.0.0.1', 4321)]]);
  });

  it('is bound only by the server start path', async () => {
    // A second `app.listen(...)` would bind the hub with Bun's defaults and
    // skip the idle timeout, the port policy and the keepalive sizing that
    // `hubListenOptions` carries. (The OAuth loopback `Bun.serve` is a separate,
    // short-lived listener, not the hub.)
    const listenCalls: string[] = [];
    for (const path of await scanSourcePaths(SRC_ROOT, '**/*.ts')) {
      const text = await Bun.file(join(SRC_ROOT, path)).text();
      for (const line of text.split('\n')) {
        if (/\bapp\.listen\(/.test(line) && !line.trimStart().startsWith('*')) {
          listenCalls.push(`${path}: ${line.trim()}`);
        }
      }
    }

    expect(listenCalls).toEqual([
      'server/start-server.ts: app.listen(hubListenOptions(host, port));',
    ]);
  });
});
