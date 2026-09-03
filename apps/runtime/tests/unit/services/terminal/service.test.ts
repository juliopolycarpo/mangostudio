import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import type { RuntimeShellKind } from '@mangostudio/shared/runtime-protocol';
import type { RuntimeEventInput } from '../../../../src/host';
import { isShellAvailable } from '../../../../src/services/shell';
import type { SpawnEnvFs } from '../../../../src/services/spawn-env';
import { TerminalNotFoundError } from '../../../../src/services/terminal/errors';
import { createTerminalService } from '../../../../src/services/terminal/service';
import { FakePtyPort } from './fake-pty';

const hasBash = isShellAvailable('bash');
const isWindows = process.platform === 'win32';

/** No files anywhere — every `auto` toolchain lookup misses. */
const NO_FILES_FS: SpawnEnvFs = {
  exists: () => false,
  readFile: () => null,
  readDirectory: () => null,
};

function createService(
  overrides: {
    sourceEnv?: () => NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    port?: FakePtyPort;
    findShell?: (kind: RuntimeShellKind) => string | null;
    homeDir?: string;
    spawnEnvFs?: SpawnEnvFs;
  } = {}
) {
  const port = overrides.port ?? new FakePtyPort();
  const events: RuntimeEventInput[] = [];
  const service = createTerminalService({
    emit: (event) => events.push(event),
    deps: {
      pty: port,
      sourceEnv:
        overrides.sourceEnv ?? (() => ({ PATH: process.env.PATH ?? '' }) as NodeJS.ProcessEnv),
      platform: overrides.platform ?? process.platform,
      homeDir: overrides.homeDir ?? homedir(),
      spawnEnvFs: overrides.spawnEnvFs ?? NO_FILES_FS,
      ...(overrides.findShell ? { findShell: overrides.findShell } : {}),
    },
  });
  return { service, port, events };
}

/** A host where every shell in `installed` is on PATH and nothing else is. */
function shellsOnPath(...installed: readonly RuntimeShellKind[]) {
  return (kind: RuntimeShellKind): string | null =>
    installed.includes(kind) ? `/fake/bin/${kind}` : null;
}

const OPEN = { sessionId: 'sess-1', cols: 80, rows: 24 } as const;

describe('createTerminalService', () => {
  it.skipIf(!hasBash)('opens a session with the resolved shell, cwd, and pid', async () => {
    const { service, port } = createService();
    const result = await service.open(OPEN);

    expect(result.sessionId).toBe('sess-1');
    expect(result.shell).toBe('bash');
    expect(result.cwd).toBe(homedir());
    expect(result.pid).toBe(port.handles[0]?.pid);
  });

  it.skipIf(!hasBash)('refuses a duplicate session id', async () => {
    const { service } = createService();
    await service.open(OPEN);

    await expect(service.open(OPEN)).rejects.toThrow(/already open/);
  });

  it.skipIf(!hasBash)('prefers the login shell when this runtime offers it', async () => {
    const { service } = createService({
      sourceEnv: () => ({ SHELL: '/usr/bin/bash' }) as NodeJS.ProcessEnv,
    });
    const result = await service.open(OPEN);
    expect(result.shell).toBe('bash');
  });

  it.skipIf(!hasBash)(
    'falls back to the fixed order when the login shell is not one it offers',
    async () => {
      const { service } = createService({
        sourceEnv: () => ({ SHELL: '/usr/bin/fish' }) as NodeJS.ProcessEnv,
      });
      const result = await service.open(OPEN);
      expect(result.shell).toBe('bash');
    }
  );

  it('prefers PowerShell on Windows even when a bash is on PATH', async () => {
    // Git for Windows and the WSL launcher both put a `bash` on a Windows PATH,
    // and neither runs on the filesystem the session's cwd names.
    const { service } = createService({
      platform: 'win32',
      findShell: shellsOnPath('bash', 'zsh', 'powershell'),
      sourceEnv: () => ({ SHELL: '/usr/bin/bash' }) as NodeJS.ProcessEnv,
    });

    const result = await service.open(OPEN);

    expect(result.shell).toBe('powershell');
  });

  it('falls back to bash on Windows when no PowerShell is installed', async () => {
    const { service } = createService({
      platform: 'win32',
      findShell: shellsOnPath('bash'),
    });

    const result = await service.open(OPEN);

    expect(result.shell).toBe('bash');
  });

  it.skipIf(isWindows)(
    'refuses an explicitly requested shell this platform does not have',
    async () => {
      const { service } = createService();
      // powershell never resolves off Windows (see services/shell.ts), so this
      // is a deterministic "unavailable" regardless of what else is installed.
      await expect(service.open({ ...OPEN, shell: 'powershell' })).rejects.toThrow(/not available/);
    }
  );

  it.skipIf(!hasBash)('falls back to home when the requested cwd does not exist', async () => {
    const { service } = createService();
    const result = await service.open({ ...OPEN, cwd: '/definitely/does-not-exist-xyz' });
    expect(result.cwd).toBe(homedir());
  });

  it.skipIf(!hasBash)('expands a bare ~ to home', async () => {
    const { service } = createService();
    const result = await service.open({ ...OPEN, cwd: '~' });
    expect(result.cwd).toBe(homedir());
  });

  it.skipIf(!hasBash)(
    'layers the sanitized env with TERM/COLORTERM/MANGOSTUDIO_TERMINAL, dropping secrets',
    async () => {
      const { service, port } = createService({
        sourceEnv: () =>
          ({
            PATH: '/usr/bin',
            ANTHROPIC_API_KEY: 'secret',
          }) as NodeJS.ProcessEnv,
      });

      await service.open({ ...OPEN, env: { CUSTOM: 'value' } });

      const env = port.spawnInputs[0]?.env;
      expect(env).toMatchObject({
        PATH: '/usr/bin',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        MANGOSTUDIO_TERMINAL: '1',
        CUSTOM: 'value',
      });
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    }
  );

  it.skipIf(!hasBash)('darwin runs a login shell; other platforms do not', async () => {
    const darwin = createService({ platform: 'darwin' });
    await darwin.service.open(OPEN);
    expect(darwin.port.spawnInputs[0]?.argv).toEqual([darwin.port.spawnInputs[0]?.argv[0], '-l']);

    const linux = createService({ platform: 'linux' });
    await linux.service.open(OPEN);
    expect(linux.port.spawnInputs[0]?.argv).toHaveLength(1);
  });

  it.skipIf(!hasBash)('attach/detach/write/resize/ack refuse an unknown session id', async () => {
    const { service } = createService();

    await expect(service.attach({ sessionId: 'ghost' })).rejects.toBeInstanceOf(
      TerminalNotFoundError
    );
    await expect(service.detach({ sessionId: 'ghost' })).rejects.toBeInstanceOf(
      TerminalNotFoundError
    );
    await expect(service.write({ sessionId: 'ghost', data: '' })).rejects.toBeInstanceOf(
      TerminalNotFoundError
    );
    await expect(service.resize({ sessionId: 'ghost', cols: 80, rows: 24 })).rejects.toBeInstanceOf(
      TerminalNotFoundError
    );
    await expect(service.ack({ sessionId: 'ghost', bytes: 0 })).rejects.toBeInstanceOf(
      TerminalNotFoundError
    );
  });

  it.skipIf(!hasBash)('closing an unknown session id is a no-op, not an error', async () => {
    const { service } = createService();
    await expect(service.closeSession({ sessionId: 'ghost' })).resolves.toEqual({ ok: true });
  });

  it.skipIf(!hasBash)('closeSession kills the pty and removes it from list()', async () => {
    const { service, port } = createService();
    await service.open(OPEN);

    await service.closeSession({ sessionId: OPEN.sessionId });

    expect(port.handles[0]?.closeCalls).toBe(1);
    expect((await service.list()).sessions).toHaveLength(0);
  });

  it.skipIf(!hasBash)('list() reports every open session, attached or not', async () => {
    const { service } = createService();
    await service.open(OPEN);
    await service.open({ ...OPEN, sessionId: 'sess-2' });
    await service.attach({ sessionId: 'sess-2' });

    const { sessions } = await service.list();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.sessionId === 'sess-1')?.attached).toBe(false);
    expect(sessions.find((session) => session.sessionId === 'sess-2')?.attached).toBe(true);
  });

  it.skipIf(!hasBash)('service close() kills every session and empties the registry', async () => {
    const { service, port } = createService();
    await service.open(OPEN);
    await service.open({ ...OPEN, sessionId: 'sess-2' });

    await service.close();

    expect(port.handles.every((handle) => handle.closeCalls === 1)).toBe(true);
    expect((await service.list()).sessions).toHaveLength(0);
  });

  it.skipIf(!hasBash)(
    'service close() keeps closing the rest when one session throws on close',
    async () => {
      const { service, port } = createService();
      await service.open(OPEN);
      await service.open({ ...OPEN, sessionId: 'sess-2' });
      port.handles[0]?.throwOnClose(new Error('pty already gone'));

      await expect(service.close()).resolves.toBeUndefined();

      expect(port.handles.every((handle) => handle.closeCalls === 1)).toBe(true);
      expect((await service.list()).sessions).toHaveLength(0);
    }
  );

  it.skipIf(!hasBash)('an emit that throws does not crash the data path', async () => {
    const port = new FakePtyPort();
    const service = createTerminalService({
      emit: () => {
        throw new Error('hub socket closed');
      },
      deps: { pty: port, sourceEnv: () => ({ PATH: process.env.PATH ?? '' }) as NodeJS.ProcessEnv },
    });

    await service.open(OPEN);
    await service.attach({ sessionId: OPEN.sessionId });

    expect(() => port.handles[0]?.emitData(new TextEncoder().encode('hi'))).not.toThrow();
  });

  it.skipIf(!hasBash)('prepends the resolved toolchain node dir to the session PATH', async () => {
    const { service, port } = createService({
      sourceEnv: () => ({ PATH: '/usr/bin' }) as NodeJS.ProcessEnv,
    });

    await service.open({
      ...OPEN,
      toolchain: { node: '/opt/custom/node/bin/node', bun: 'auto' },
    });

    expect(port.spawnInputs[0]?.env.PATH).toBe('/opt/custom/node/bin:/usr/bin');
  });

  it.skipIf(!hasBash)('leaves PATH untouched when the open carries no toolchain', async () => {
    const { service, port } = createService({
      sourceEnv: () => ({ PATH: '/usr/bin' }) as NodeJS.ProcessEnv,
    });

    await service.open(OPEN);

    expect(port.spawnInputs[0]?.env.PATH).toBe('/usr/bin');
  });
});
