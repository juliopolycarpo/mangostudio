import { describe, expect, it } from 'bun:test';

import type { Page } from '@playwright/test';

import { watchRealtime } from '../../tests/browser-smoke/support/realtime-probe';

class FakeClock {
  elapsed = 0;
  now = () => this.elapsed;
  sleep = (ms: number) => {
    this.elapsed += ms;
    return Promise.resolve();
  };
}

class HeldClock {
  now = () => 0;
  private release?: () => void;
  sleep = () =>
    new Promise<void>((resolve) => {
      this.release = resolve;
    });
  tick() {
    this.release?.();
  }
}

class FakeSocket {
  private handlers = new Map<string, (event: never) => void>();
  private closed = false;
  constructor(private address = 'ws://localhost/api/ws') {}
  url() {
    return this.address;
  }
  isClosed() {
    return this.closed;
  }
  on(name: string, handler: (event: never) => void) {
    this.handlers.set(name, handler);
  }
  receive(payload: string) {
    this.handlers.get('framereceived')?.({ payload } as never);
  }
  send(payload: string) {
    this.handlers.get('framesent')?.({ payload } as never);
  }
  close() {
    this.closed = true;
    this.handlers.get('close')?.(undefined as never);
  }
  error() {
    this.handlers.get('socketerror')?.('secret-error' as never);
  }
}

class FakePage {
  private handler?: (socket: FakeSocket) => void;
  on(_event: string, handler: (socket: FakeSocket) => void) {
    this.handler = handler;
  }
  open(socket: FakeSocket) {
    this.handler?.(socket);
  }
  asPage() {
    return this as unknown as Page;
  }
}

const ack = JSON.stringify({ type: 'subscribed', topics: ['activity'] });
const invalidation = JSON.stringify({ type: 'invalidate', topic: 'activity' });

describe('browser realtime probe', () => {
  it('does not resolve from a closed socket acknowledgement after replacement', async () => {
    const page = new FakePage();
    const clock = new HeldClock();
    const probe = watchRealtime(page.asPage(), { clock });
    const old = new FakeSocket();
    page.open(old);
    old.receive(ack);
    old.close();
    const current = new FakeSocket();
    page.open(current);
    let prematurelyReady = false;
    const waiting = probe.subscribed('replacement');
    void waiting.then(() => {
      prematurelyReady = true;
    });
    await Promise.resolve();
    expect(prematurelyReady).toBe(false);
    current.receive(ack);
    clock.tick();
    await waiting;
  });

  it('requires an acknowledgement from the current live socket', async () => {
    const page = new FakePage();
    const clock = new FakeClock();
    const probe = watchRealtime(page.asPage(), { clock, timeoutMs: 200 });
    const old = new FakeSocket();
    page.open(old);
    old.receive(ack);
    await probe.subscribed('old');
    old.close();
    const current = new FakeSocket();
    page.open(current);
    old.receive(ack);
    old.receive(invalidation);
    await expect(probe.subscribed('replacement')).rejects.toThrow(
      'replacement activity subscription ack within 200 ms'
    );
    expect(probe.invalidations()).toBe(0);
    expect(probe.opened()).toBe(2);
    current.receive(ack);
    await probe.subscribed('replacement');
    current.receive(invalidation);
    expect(probe.invalidations()).toBe(1);
    current.close();
    current.receive(ack);
    await expect(probe.subscribed('closed')).rejects.toThrow(
      'closed activity subscription ack within 200 ms'
    );
  });

  it('rejects replaced socket frames even when the old socket did not close', async () => {
    const page = new FakePage();
    const clock = new FakeClock();
    const probe = watchRealtime(page.asPage(), { clock, timeoutMs: 100 });
    const old = new FakeSocket();
    page.open(old);
    const current = new FakeSocket();
    page.open(current);
    old.receive(ack);
    old.receive(invalidation);
    old.close();
    await expect(probe.subscribed('new')).rejects.toThrow('new activity subscription ack');
    expect(probe.invalidations()).toBe(0);
    current.receive(ack);
    await probe.subscribed('new');
  });

  it('ignores non realtime sockets and malformed or non activity messages', async () => {
    const page = new FakePage();
    const clock = new FakeClock();
    const probe = watchRealtime(page.asPage(), { clock, timeoutMs: 100 });
    const unrelated = new FakeSocket('ws://localhost/api/terminal?token=private');
    page.open(unrelated);
    unrelated.receive(ack);
    const socket = new FakeSocket('ws://localhost/api/ws?token=private');
    page.open(socket);
    socket.receive('{"type":"subscribed","topics":["settings"],"secret":"activity"}');
    socket.receive('not-json subscribed activity');
    socket.receive(JSON.stringify({ type: 'invalidate', topic: 'settings' }));
    await expect(probe.subscribed('tab')).rejects.toThrow('tab activity subscription ack');
    expect(probe.opened()).toBe(1);
    expect(probe.invalidations()).toBe(0);
    socket.receive(ack);
    await probe.subscribed('tab');
    socket.send(JSON.stringify({ type: 'unsubscribe', topics: ['activity'] }));
    await expect(probe.subscribed('unsubscribed')).rejects.toThrow(
      'unsubscribed activity subscription ack'
    );
  });

  it('bounds and sanitizes lifecycle and frame diagnostics', async () => {
    const page = new FakePage();
    const clock = new FakeClock();
    const probe = watchRealtime(page.asPage(), { clock, timeoutMs: 100 });
    const socket = new FakeSocket('ws://private-host/api/ws?token=secret-token');
    page.open(socket);
    socket.send(JSON.stringify({ type: 'subscribe', topics: ['activity'] }));
    socket.receive(JSON.stringify({ type: 'error', error: 'secret-error', code: 'secret-code' }));
    socket.receive('{"token":"secret-frame"}');
    socket.error();
    const first = await probe.subscribed('tab').catch((error: unknown) => String(error));
    expect(first).toContain('send:subscribe:activity:current');
    expect(first).toContain('receive:error:other:current');
    expect(first).toContain('receive:invalid');
    expect(first).toContain('error:current');
    expect(first).not.toContain('secret');
    for (let i = 0; i < 30; i++) socket.receive(JSON.stringify({ type: 'ready' }));
    socket.close();
    try {
      await probe.subscribed('tab');
      throw new Error('expected timeout');
    } catch (error) {
      const message = String(error);
      expect(message).toContain('1 realtime socket(s) opened');
      expect(message).toContain('close:current');
      expect(message).not.toContain('secret');
      expect(message).not.toContain('private-host');
      expect(message.length).toBeLessThan(1_000);
    }
  });
});
