import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { websocket } from 'elysia/websocket';
import { listenOnEphemeralPort } from '../../support/listen-ephemeral';

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
    const app = {
      listen: (_port: number, callback: (server: { port?: number }) => void) => callback({}),
    };

    await expect(listenOnEphemeralPort(app)).rejects.toThrow(
      'expected a numeric listening port | received: undefined'
    );
  });
});
