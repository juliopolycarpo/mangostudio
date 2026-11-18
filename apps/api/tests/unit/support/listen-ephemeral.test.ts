import { afterEach, describe, expect, it } from 'bun:test';

import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';

import { listenOnEphemeralPort, stopEphemeralServer } from '../../support/listen-ephemeral';

class NeverPublishingApp {
  stopped = false;
  server = { port: 12345 };

  listen(_port: number, _callback: (server: { port?: number }) => void): void {
    // Simulate a bound server whose publish callback never runs.
  }

  stop(force: boolean): void {
    this.stopped = force;
  }
}

class PortlessApp {
  stopped = false;

  listen(_port: number, callback: (server: { port?: number }) => void): void {
    callback({});
  }

  stop(force: boolean): void {
    this.stopped = force;
  }
}

let stopServer: (() => void) | undefined;

afterEach(() => {
  stopServer?.();
  stopServer = undefined;
});

describe('listenOnEphemeralPort', () => {
  it('resolves only once the very first upgrade on a fresh app is accepted', async () => {
    const app = new Elysia().use(websocket()).ws('/echo', {
      message(socket, message) {
        socket.send(message);
      },
    });
    const port = await listenOnEphemeralPort(app);
    stopServer = () => {
      void app.server?.stop(true);
    };

    const socket = new WebSocket(`ws://127.0.0.1:${port}/echo`);
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => resolve('open'), { once: true });
      socket.addEventListener('close', (event) => resolve(`closed ${event.code}`), { once: true });
    });
    socket.close();

    expect(outcome).toBe('open');
  });

  it('names the port it received when the server reports none', async () => {
    const app = new PortlessApp();

    await expect(listenOnEphemeralPort(app)).rejects.toThrow(
      'expected a numeric listening port | received: undefined'
    );
  });

  it('stops a bound server if Elysia never publishes its handlers', async () => {
    const app = new NeverPublishingApp();

    await expect(listenOnEphemeralPort(app)).rejects.toThrow('no listen callback');

    expect(app.stopped).toBe(true);
  }, 10_000);
});

class NeverStoppingApp {
  stop(_force: boolean): Promise<void> {
    return new Promise(() => {});
  }
}

describe('stopEphemeralServer', () => {
  it('releases the app so the same instance can listen again', async () => {
    const app = new Elysia().get('/ping', () => 'pong');
    await listenOnEphemeralPort(app);

    await stopEphemeralServer(app);

    const port = await listenOnEphemeralPort(app);
    stopServer = () => {
      void app.server?.stop(true);
    };
    expect(port).toBeGreaterThan(0);
  });

  it('is the difference from stopping the Bun server directly, which keeps listen() refused', async () => {
    // The mechanism behind #2482: app-plugin-contract stopped the shared app
    // with `app.server.stop(true)`, and the next file to listen on it threw.
    const app = new Elysia().get('/ping', () => 'pong');
    await listenOnEphemeralPort(app);
    await app.server?.stop(true);

    await expect(listenOnEphemeralPort(app)).rejects.toThrow(
      'Cannot call listen() while a server or teardown is active'
    );

    await stopEphemeralServer(app);
    const port = await listenOnEphemeralPort(app);
    stopServer = () => {
      void app.server?.stop(true);
    };
    expect(port).toBeGreaterThan(0);
  });

  it('names the pending teardown when stop never settles', async () => {
    await expect(stopEphemeralServer(new NeverStoppingApp())).rejects.toThrow(
      'expected app.stop(true) to settle within 5000ms | received: teardown still pending'
    );
  }, 10_000);
});
