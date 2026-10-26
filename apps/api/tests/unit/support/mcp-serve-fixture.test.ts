import { describe, expect, it } from 'bun:test';
import { startMcpServeFixture } from '../../support/mcp-serve-fixture';
import type { RustServeRuntime, StartRustServeOptions } from '../../support/rust-serve-runtime';

class FakeDeadline {
  readonly controller = new AbortController();
  readonly requests: number[] = [];
  clears = 0;
  create = (timeoutMs: number) => {
    this.requests.push(timeoutMs);
    return { signal: this.controller.signal, clear: () => this.clears++ };
  };
}

class FakeServe {
  closes = 0;
  disconnects = 0;
  options: StartRustServeOptions | undefined;
  readonly runtime: RustServeRuntime = {
    port: 12345,
    baseUrl: 'http://127.0.0.1:12345',
    wsUrl: 'ws://127.0.0.1:12345',
    mangoHome: '/unused-named-fake-home',
    close: () => {
      this.closes++;
      return Promise.resolve();
    },
  };
  start = (_binary: string, options: StartRustServeOptions) => {
    this.options = options;
    return Promise.resolve(this.runtime);
  };
  disconnect = () => {
    this.disconnects++;
    return Promise.resolve();
  };
}

class PendingConnection {
  signal: AbortSignal | undefined;
  readonly entered = Promise.withResolvers<void>();
  connect = async (_runtime: RustServeRuntime, signal: AbortSignal) => {
    this.signal = signal;
    this.entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

describe('MCP serve fixture ownership', () => {
  it('uses one 10000ms deadline through health and pending WebSocket setup', async () => {
    const deadline = new FakeDeadline();
    const serve = new FakeServe();
    const connection = new PendingConnection();
    const pending = startMcpServeFixture(
      'named-runtime',
      {
        label: 'deadline',
        token: 'synthetic',
        connect: connection.connect,
        disconnect: serve.disconnect,
      },
      { start: serve.start, deadline: deadline.create }
    );
    await connection.entered.promise;
    const expired = new Error('named shared startup deadline');
    deadline.controller.abort(expired);
    expect(await pending.catch((error: unknown) => error)).toBe(expired);
    expect(deadline.requests).toEqual([10_000]);
    expect(connection.signal).toBe(serve.options?.signal);
    expect(serve.closes).toBe(1);
    expect(serve.disconnects).toBe(1);
    expect(deadline.clears).toBe(1);
  });

  it('closes a runtime whose health completes after the shared deadline without connecting', async () => {
    const deadline = new FakeDeadline();
    const serve = new FakeServe();
    const expired = new Error('named expired health receipt');
    deadline.controller.abort(expired);
    let connects = 0;
    const result = await startMcpServeFixture(
      'named-runtime',
      {
        label: 'expired-health',
        token: 'synthetic',
        connect: () => {
          connects++;
          return Promise.resolve();
        },
        disconnect: serve.disconnect,
      },
      { start: serve.start, deadline: deadline.create }
    ).catch((error: unknown) => error);
    expect(result).toBe(expired);
    expect(connects).toBe(0);
    expect(serve.closes).toBe(1);
    expect(serve.disconnects).toBe(1);
    expect(deadline.clears).toBe(1);
  });

  it('preserves a startup failure and attempts runtime cleanup when manager shutdown fails', async () => {
    const deadline = new FakeDeadline();
    const serve = new FakeServe();
    const primary = new Error('named connection refusal');
    const result = await startMcpServeFixture(
      'named-runtime',
      {
        label: 'rollback',
        token: 'synthetic',
        connect: () => Promise.reject(primary),
        disconnect: () => Promise.reject(new Error('named shutdown failure')),
      },
      { start: serve.start, deadline: deadline.create }
    ).catch((error: unknown) => error);
    expect(result).toBe(primary);
    expect(serve.closes).toBe(1);
    expect(deadline.clears).toBe(1);
  });

  it('releases the deadline after successful setup and closes both owners on teardown', async () => {
    const deadline = new FakeDeadline();
    const serve = new FakeServe();
    const fixture = await startMcpServeFixture(
      'named-runtime',
      {
        label: 'ready',
        token: 'synthetic',
        connect: () => Promise.resolve(),
        disconnect: serve.disconnect,
      },
      { start: serve.start, deadline: deadline.create }
    );
    expect(deadline.clears).toBe(1);
    expect(serve.closes).toBe(0);
    await fixture.close();
    expect(serve.closes).toBe(1);
    expect(serve.disconnects).toBe(1);
  });
});
