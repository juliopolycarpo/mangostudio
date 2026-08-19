import { afterEach, describe, expect, it } from 'bun:test';
import {
  type ChatGptLoopbackServer,
  ChatGptOAuthPortBusyError,
  setChatGptLoopbackPortForTest,
  startChatGptLoopbackServer,
} from '../../../../src/modules/connectors/infrastructure/chatgpt/loopback-server';

// The test environment already pins the loopback port to 0, so every server
// here takes an OS-assigned port and the callback base follows the bound one.
const callbackBase = (server: ChatGptLoopbackServer): string => `http://127.0.0.1:${server.port}`;

let activeServer: ChatGptLoopbackServer | null = null;

function startServer(overrides: Partial<Parameters<typeof startChatGptLoopbackServer>[0]> = {}): {
  server: ChatGptLoopbackServer;
  codes: string[];
  failures: string[];
} {
  const codes: string[] = [];
  const failures: string[] = [];
  const server = startChatGptLoopbackServer({
    expectedState: 'expected-state',
    ttlMs: 30_000,
    onAuthorizationCode: (code) => {
      codes.push(code);
      return Promise.resolve();
    },
    onFailure: (message) => {
      failures.push(message);
    },
    ...overrides,
  });
  activeServer = server;
  return { server, codes, failures };
}

afterEach(() => {
  activeServer?.stop();
  activeServer = null;
  setChatGptLoopbackPortForTest(0);
});

describe('chatgpt loopback server', () => {
  it('accepts the callback when the state matches', async () => {
    const { server, codes, failures } = startServer();

    const response = await fetch(
      `${callbackBase(server)}/auth/callback?code=auth-code-1&state=expected-state`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('close this tab');
    expect(codes).toEqual(['auth-code-1']);
    expect(failures).toEqual([]);
  });

  it('rejects a state mismatch without invoking the code handler', async () => {
    const { server, codes, failures } = startServer();

    const response = await fetch(
      `${callbackBase(server)}/auth/callback?code=auth-code-1&state=attacker-state`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('failed');
    expect(codes).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it('propagates OAuth errors from the issuer redirect', async () => {
    const { server, codes, failures } = startServer();

    await fetch(`${callbackBase(server)}/auth/callback?error=access_denied`);

    expect(codes).toEqual([]);
    expect(failures[0]).toContain('access_denied');
  });

  it('returns 404 for anything but the callback path', async () => {
    const { server } = startServer();

    const response = await fetch(`${callbackBase(server)}/some/other/path`);

    expect(response.status).toBe(404);
  });

  it('binds a distinct port per server rather than one shared port', () => {
    const first = startServer();
    const second = startServer();

    try {
      expect(first.server.port).toBeGreaterThan(0);
      expect(second.server.port).not.toBe(first.server.port);
    } finally {
      first.server.stop();
    }
  });

  it('throws ChatGptOAuthPortBusyError when the port is already bound', () => {
    const { server } = startServer();

    // Pin the override to a port this test already holds, so the collision is
    // arranged rather than raced against whatever else is on the machine.
    setChatGptLoopbackPortForTest(server.port);

    expect(() => startServer()).toThrow(ChatGptOAuthPortBusyError);
  });
});
