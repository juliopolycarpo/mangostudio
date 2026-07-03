import { afterEach, describe, expect, it } from 'bun:test';
import {
  type ChatGptLoopbackServer,
  ChatGptOAuthPortBusyError,
  startChatGptLoopbackServer,
} from '../../../../src/modules/connectors/infrastructure/chatgpt/loopback-server';
import { CHATGPT_OAUTH_CALLBACK_PORT } from '../../../../src/modules/connectors/infrastructure/chatgpt/oauth-constants';

const CALLBACK_BASE = `http://127.0.0.1:${CHATGPT_OAUTH_CALLBACK_PORT}`;

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
});

describe('chatgpt loopback server', () => {
  it('accepts the callback when the state matches', async () => {
    const { codes, failures } = startServer();

    const response = await fetch(
      `${CALLBACK_BASE}/auth/callback?code=auth-code-1&state=expected-state`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('close this tab');
    expect(codes).toEqual(['auth-code-1']);
    expect(failures).toEqual([]);
  });

  it('rejects a state mismatch without invoking the code handler', async () => {
    const { codes, failures } = startServer();

    const response = await fetch(
      `${CALLBACK_BASE}/auth/callback?code=auth-code-1&state=attacker-state`
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('failed');
    expect(codes).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it('propagates OAuth errors from the issuer redirect', async () => {
    const { codes, failures } = startServer();

    await fetch(`${CALLBACK_BASE}/auth/callback?error=access_denied`);

    expect(codes).toEqual([]);
    expect(failures[0]).toContain('access_denied');
  });

  it('returns 404 for anything but the callback path', async () => {
    startServer();

    const response = await fetch(`${CALLBACK_BASE}/some/other/path`);

    expect(response.status).toBe(404);
  });

  it('throws ChatGptOAuthPortBusyError when the port is already bound', () => {
    startServer();

    expect(() => startServer()).toThrow(ChatGptOAuthPortBusyError);
  });
});
