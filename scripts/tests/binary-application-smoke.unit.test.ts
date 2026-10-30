import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatSchema } from '@mangostudio/shared/chat';
import { Create } from 'typebox/value';

import { assertSmokeSchema, smokeBinaryApplication } from '../lib/binary-application-smoke';
import { type ApplicationFault, FakeBinaryApplication } from './support/fake-binary-application';
import { discoverWindowsAliases, queryAliasPair, shortPath } from './support/windows-path-aliases';

const windowsAliases = process.platform === 'win32' ? discoverWindowsAliases() : undefined;

class FakePollingClock {
  elapsed = 0;
  readonly now = (): number => this.elapsed;
  readonly sleep = (): Promise<void> => {
    this.elapsed += 10;
    return Promise.resolve();
  };
}

describe('built hub application qualification', () => {
  let restoreClock: () => void;
  beforeEach(() => {
    const clock = new FakePollingClock();
    const now = spyOn(performance, 'now').mockImplementation(clock.now);
    const sleep = spyOn(Bun, 'sleep').mockImplementation(clock.sleep);
    restoreClock = () => {
      now.mockRestore();
      sleep.mockRestore();
    };
  });
  afterEach(() => restoreClock());

  test('advances the polling clock by one interval per sleep', async () => {
    expect(performance.now()).toBe(0);
    await Bun.sleep(10);
    await Bun.sleep(10);
    expect(performance.now()).toBe(20);
  });
  test('validates canonical CRUD, websocket activity, Local health and the same database after restart', async () => {
    const fake = new FakeBinaryApplication();
    await smokeBinaryApplication(fake.options());
    expect(fake.restarted).toBe(true);
    expect(fake.socket.isClosed).toBe(true);
    expect(fake.requests).toEqual([
      'POST /api/chats/',
      'POST /api/chats/',
      'PUT /api/chats/fixture-chat',
      'GET /api/chats/',
      'POST /api/environments/local/connect',
      'GET /api/environments/local/runtime',
      'GET /api/chats/',
      'DELETE /api/chats/fixture-chat',
      'GET /api/chats/',
    ]);
    expect(fake.chat).toBeUndefined();
  });
  test('Windows disconnects Local and awaits its exit before terminating the hub', async () => {
    const fake = new FakeBinaryApplication();
    await smokeBinaryApplication({ ...fake.options(), platform: 'win32' });
    expect(fake.events).toEqual([
      'baseline',
      'connect',
      'observe',
      'disconnect',
      'runtime-exited',
      'restart',
    ]);
  });
  test('compares both runtime and home through the injected canonical resolver', async () => {
    const fake = new FakeBinaryApplication();
    fake.runtimePath = 'C:\\RUNNER~1\\runtime.exe';
    fake.reportedRuntimePath = 'C:\\runneradmin\\runtime.exe';
    fake.home = 'C:\\RUNNER~1\\home';
    fake.reportedHome = 'C:\\runneradmin\\home';
    fake.pathAliases.set(fake.runtimePath, fake.reportedRuntimePath);
    fake.pathAliases.set(fake.home, fake.reportedHome);
    await smokeBinaryApplication(fake.options());
    expect(fake.restarted).toBe(true);
  });
  test.skipIf(!windowsAliases || windowsAliases.kind === 'unavailable')(
    'native Windows accepts available 8.3 aliases',
    async () => {
      if (!windowsAliases) throw new Error('expected Windows alias discovery');
      if (windowsAliases.kind === 'failure') throw windowsAliases.error;
      if (windowsAliases.kind !== 'available')
        throw new Error('expected available Windows aliases');
      const fake = new FakeBinaryApplication();
      fake.runtimePath = windowsAliases.paths.binaryAlias;
      fake.reportedRuntimePath = windowsAliases.paths.binaryPath;
      fake.home = windowsAliases.paths.homeAlias;
      fake.reportedHome = windowsAliases.paths.home;
      await smokeBinaryApplication({ ...fake.options(), canonicalPath: undefined });
      expect(fake.restarted).toBe(true);
    }
  );

  test('default resolver accepts the same entries and rejects same-content runtime and empty-home copies', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'application-path-identity-'));
    try {
      const runtime = join(directory, 'runtime');
      const foreignRuntime = join(directory, 'same-content-runtime');
      const firstHome = join(directory, 'first-home');
      const secondHome = join(directory, 'second-home');
      writeFileSync(runtime, 'same runtime bytes');
      copyFileSync(runtime, foreignRuntime);
      mkdirSync(firstHome);
      mkdirSync(secondHome);

      const sameEntries = new FakeBinaryApplication();
      sameEntries.runtimePath = sameEntries.reportedRuntimePath = runtime;
      sameEntries.home = sameEntries.reportedHome = firstHome;
      await smokeBinaryApplication({ ...sameEntries.options(), canonicalPath: undefined });
      expect(sameEntries.restarted).toBe(true);

      const wrongRuntime = new FakeBinaryApplication();
      wrongRuntime.runtimePath = runtime;
      wrongRuntime.reportedRuntimePath = foreignRuntime;
      wrongRuntime.home = wrongRuntime.reportedHome = firstHome;
      await expect(
        smokeBinaryApplication({ ...wrongRuntime.options(), canonicalPath: undefined })
      ).rejects.toThrow('expected fresh sibling runtime');

      const wrongHome = new FakeBinaryApplication();
      wrongHome.runtimePath = wrongHome.reportedRuntimePath = runtime;
      wrongHome.home = firstHome;
      wrongHome.reportedHome = secondHome;
      await expect(
        smokeBinaryApplication({ ...wrongHome.options(), canonicalPath: undefined })
      ).rejects.toThrow('expected fresh sibling runtime');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('schema countercontrol names the invalid title and its expected string shape', () => {
    const chat = Create(ChatSchema);
    expect(assertSmokeSchema(ChatSchema, chat, 'chat')).toEqual(chat);
    expect(() => assertSmokeSchema(ChatSchema, { ...chat, title: 123 }, 'chat')).toThrow(
      '"instancePath":"/title"'
    );
  });
  test.each([
    ['bad-connect-envelope', 'Local connect', '/name'],
    ['bad-runtime-envelope', 'Local runtime', '/readAt'],
    ['bad-disconnect-envelope', 'Local disconnect', '/enabled'],
  ] as const)('rejects %s outside the canonical response schema', async (fault, label, path) => {
    const fake = new FakeBinaryApplication(fault);
    await expect(smokeBinaryApplication({ ...fake.options(), platform: 'win32' })).rejects.toThrow(
      new RegExp(`${label}: expected canonical schema.*"instancePath":"${path}"`)
    );
    expect(fake.socket.isClosed).toBe(true);
    expect(fake.restarted).toBe(false);
  });
  const cases: [ApplicationFault, string][] = [
    ['bad-title', 'created chat: expected canonical schema'],
    ['bad-list', 'chat list: expected canonical schema'],
    ['wrong-error', 'expected 422 VALIDATION'],
    ['lost-database', 'expected persisted fixture-chat'],
    ['wrong-runtime', 'expected fresh sibling runtime'],
    ['wrong-home', 'expected fresh sibling runtime'],
    ['missing-pong', 'expected pong within 30ms'],
    ['wrong-activity', 'expected activity invalidation'],
    ['bad-json', 'received malformed JSON object'],
    ['closed', 'received connection closed'],
    ['bad-subscription', 'expected activity subscription'],
    ['bad-update', 'update chat: expected success true'],
    ['bad-delete', 'delete chat: expected success true'],
    ['retained-chat', 'expected fixture-chat absent after delete'],
  ];
  test.each(cases)('rejects %s for its intended reason', async (fault, message) => {
    const fake = new FakeBinaryApplication(fault);
    await expect(smokeBinaryApplication(fake.options())).rejects.toThrow(message);
    if (fault !== 'wrong-error') expect(fake.socket.isClosed).toBe(true);
  });
});

test('reports alias query termination details', () => {
  const timeout = Object.assign(new Error('spawnSync cmd.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const failedQuery = () => ({
    status: null,
    signal: 'SIGTERM' as const,
    error: timeout,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from('stopped', 'utf16le'),
    pid: 1,
    output: [],
  });
  expect(() => shortPath('C:\\fixture', failedQuery)).toThrow(
    /status.*null.*signal.*SIGTERM.*ETIMEDOUT.*stopped/s
  );
});

test('rejects invalid alias query input and ambiguous output', () => {
  const unexpectedQuery = () => {
    throw new Error('query should not run');
  };
  expect(() => shortPath('C:\\bad"path', unexpectedQuery)).toThrow('without quotes or newlines');
  expect(() => shortPath('C:\\bad\npath', unexpectedQuery)).toThrow('without quotes or newlines');
  const ambiguousQuery = () => ({
    status: 0,
    signal: null,
    stdout: Buffer.from('one\r\ntwo\r\n', 'utf16le'),
    stderr: Buffer.alloc(0),
    pid: 1,
    output: [],
  });
  expect(() => shortPath('C:\\fixture', ambiguousQuery)).toThrow('expected one Windows short path');
});

test('shares the alias query deadline and stops when it expires', () => {
  let elapsed = 0;
  const calls: Array<[string, number]> = [];
  const clock = () => elapsed;
  const query = (path: string, timeoutMs: number) => {
    calls.push([path, timeoutMs]);
    elapsed += 1_250;
    return `${path}-alias`;
  };
  expect(queryAliasPair('file', 'home', query, clock)).toEqual(['file-alias', 'home-alias']);
  expect(calls).toEqual([
    ['file', 5000],
    ['home', 3750],
  ]);
  elapsed = 0;
  calls.length = 0;
  const stalledQuery = (path: string, timeoutMs: number) => {
    calls.push([path, timeoutMs]);
    elapsed = 5_000;
    return 'file-alias';
  };
  expect(() => queryAliasPair('file', 'home', stalledQuery, clock)).toThrow('deadline expired');
  expect(calls).toEqual([['file', 5000]]);
  elapsed = 0;
  calls.length = 0;
  const lateSecondQuery = (path: string, timeoutMs: number) => {
    calls.push([path, timeoutMs]);
    elapsed += path === 'file' ? 1_250 : 4_000;
    return `${path}-alias`;
  };
  expect(() => queryAliasPair('file', 'home', lateSecondQuery, clock)).toThrow('deadline expired');
  expect(calls).toEqual([
    ['file', 5000],
    ['home', 3750],
  ]);
});

test('distinguishes unavailable aliases from failed discovery', () => {
  const failure = new Error('alias query failed');
  const unavailable = () => undefined;
  const failed = () => {
    throw failure;
  };
  expect(discoverWindowsAliases(unavailable)).toEqual({ kind: 'unavailable' });
  expect(discoverWindowsAliases(failed)).toEqual({ kind: 'failure', error: failure });
});

test.skipIf(process.platform !== 'win32')(
  'queries literal Windows paths without interpreting their characters',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'windows-alias-hostile-'));
    try {
      const hostile = join(directory, 'spaces & (parentheses) ! %PATH% café');
      mkdirSync(hostile);
      const file = join(hostile, 'literal & (file) ! %PATH% café.txt');
      writeFileSync(file, 'fixture');
      expect(realpathSync.native(shortPath(hostile))).toBe(realpathSync.native(hostile));
      expect(realpathSync.native(shortPath(file))).toBe(realpathSync.native(file));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
