import { afterEach, describe, expect, it, jest } from 'bun:test';

import { probeSshClient, type SshClientProcess } from '../../../src/cli/ssh-client-probe';

class FakeSshClient implements SshClientProcess {
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly signals: Array<'SIGKILL' | undefined> = [];
  readonly paths: string[] = [];
  cancelled = false;
  private output!: ReadableStreamDefaultController<Uint8Array>;
  private finish!: (code: number) => void;
  private outputFinished = false;

  constructor(
    private readonly keepOutputOpen = false,
    private readonly exitOnKill = true
  ) {
    this.stderr = new ReadableStream({
      start: (controller) => {
        this.output = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  spawn = (path: string): SshClientProcess => {
    this.paths.push(path);
    return this;
  };

  write(text: string): void {
    this.output.enqueue(new TextEncoder().encode(text));
  }

  exit(code: number): void {
    this.finish(code);
  }

  closeOutput(): void {
    if (this.cancelled || this.outputFinished) return;
    this.outputFinished = true;
    this.output.close();
  }

  failOutput(error: Error): void {
    this.outputFinished = true;
    this.output.error(error);
  }

  kill(signal?: 'SIGKILL'): void {
    this.signals.push(signal);
    if (this.exitOnKill) this.exit(signal === 'SIGKILL' ? 137 : 143);
    if (!this.keepOutputOpen) this.closeOutput();
  }
}

function unavailableSsh(): never {
  throw new Error('spawn ssh: expected runnable executable | received: unavailable');
}

afterEach(() => {
  jest.useRealTimers();
});

describe('probeSshClient', () => {
  it('reports a missing client without spawning', async () => {
    expect(await probeSshClient(null, unavailableSsh)).toEqual({
      path: null,
      version: null,
      error: null,
    });
  });

  it('reports a spawn failure', async () => {
    expect(await probeSshClient('/missing/ssh', unavailableSsh)).toEqual({
      path: '/missing/ssh',
      version: null,
      error: 'spawn ssh: expected runnable executable | received: unavailable',
    });
  });

  it('accepts the first stderr banner only after output and process exit settle', async () => {
    const child = new FakeSshClient();
    const result = probeSshClient('/tools/ssh', child.spawn);
    child.write('OpenSSH_10.2, OpenSSL 3.5\r\nextra detail\n');
    child.closeOutput();
    child.exit(0);
    expect(await result).toEqual({
      path: '/tools/ssh',
      version: 'OpenSSH_10.2, OpenSSL 3.5',
      error: null,
    });
    expect(child.paths).toEqual(['/tools/ssh']);
    expect(child.signals).toEqual([]);
  });

  it('rejects a nonzero ssh -V even when stderr has text', async () => {
    const child = new FakeSshClient();
    const result = probeSshClient('/tools/ssh', child.spawn);
    child.write('ssh: unsupported option\n');
    child.closeOutput();
    child.exit(1);
    expect(await result).toEqual({
      path: '/tools/ssh',
      version: null,
      error: 'ssh: unsupported option',
    });
  });

  it('reports an empty successful response', async () => {
    const child = new FakeSshClient();
    const result = probeSshClient('/tools/ssh', child.spawn);
    child.closeOutput();
    child.exit(0);
    expect((await result).error).toBe('printed no version');
  });

  it('retains a stderr read error while killing and reaping the child', async () => {
    const child = new FakeSshClient();
    const result = probeSshClient('/tools/ssh', child.spawn);
    child.failOutput(new Error('stderr: expected readable pipe | received: broken pipe'));
    expect((await result).error).toBe('stderr: expected readable pipe | received: broken pipe');
    expect(child.signals).toEqual(['SIGKILL']);
    expect(await child.exited).toBe(137);
  });

  it('clears the deadline after a successful probe', async () => {
    jest.useFakeTimers();
    const child = new FakeSshClient();
    const result = probeSshClient('/tools/ssh', child.spawn);
    child.write('OpenSSH_10.2');
    child.closeOutput();
    child.exit(0);
    expect((await result).version).toBe('OpenSSH_10.2');
    jest.advanceTimersByTime(5_000);
    expect(child.signals).toEqual([]);
  });

  it('names the deadline rather than reporting the signal exit as a client failure', async () => {
    jest.useFakeTimers();
    const child = new FakeSshClient();
    const result = probeSshClient('/tools/ssh', child.spawn);
    jest.advanceTimersByTime(4_999);
    expect(child.signals).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(await result).toEqual({
      path: '/tools/ssh',
      version: null,
      error: 'ssh -V timed out after 5000 ms',
    });
    expect(child.signals).toEqual(['SIGKILL']);
  });

  it('keeps ownership until the timed-out process actually exits', async () => {
    jest.useFakeTimers();
    const child = new FakeSshClient(true, false);
    let settled = false;
    const result = probeSshClient('/tools/ssh', child.spawn).then((probe) => {
      settled = true;
      return probe;
    });
    try {
      jest.advanceTimersByTime(5_000);
      jest.useRealTimers();
      await Bun.sleep(0);
      expect(child.cancelled).toBe(true);
      expect(settled).toBe(false);
      expect(child.signals).toEqual(['SIGKILL']);
      child.exit(137);
      expect((await result).error).toBe('ssh -V timed out after 5000 ms');
    } finally {
      child.exit(137);
      child.closeOutput();
      await result;
    }
  });

  it('settles a timed-out stderr pipe that remains open after process exit', async () => {
    jest.useFakeTimers();
    const child = new FakeSshClient(true);
    let settled = false;
    const result = probeSshClient('/tools/ssh', child.spawn).then((probe) => {
      settled = true;
      return probe;
    });
    try {
      jest.advanceTimersByTime(5_000);
      jest.useRealTimers();
      await Bun.sleep(0);
      expect(child.cancelled).toBe(true);
      expect(settled).toBe(true);
      expect((await result).error).toBe('ssh -V timed out after 5000 ms');
    } finally {
      child.closeOutput();
      await result;
    }
  });
});
