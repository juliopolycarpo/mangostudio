import { afterEach, describe, expect, it } from 'bun:test';
import type { ConnectMcpClientOptions } from '../../../../src/services/mcp/client-factory';
import {
  closeAllMcpClients,
  disposeMcpServer,
  getMcpClient,
  getMcpRuntimeStatus,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import type { McpClientHandle, McpServerRuntimeConfig } from '../../../../src/services/mcp/types';

function makeConfig(id: string): McpServerRuntimeConfig {
  return {
    id,
    slug: id,
    transport: 'stdio',
    command: 'bun',
    args: [],
    env: {},
    url: null,
    timeoutMs: null,
  };
}

function makeHandle(onClose?: () => void): McpClientHandle {
  return {
    listTools: () => Promise.resolve([]),
    callTool: () => Promise.resolve({ contentText: '', isError: false, rawContentKinds: [] }),
    close: () => {
      onClose?.();
      return Promise.resolve();
    },
  };
}

afterEach(async () => {
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
});

describe('mcp connection manager', () => {
  it('shares one in-flight connect between concurrent callers', async () => {
    let connectCalls = 0;
    setMcpClientConnectorForTest(async () => {
      connectCalls += 1;
      await Bun.sleep(20);
      return makeHandle();
    });

    const config = makeConfig('server-1');
    const [first, second] = await Promise.all([
      getMcpClient('user-1', config),
      getMcpClient('user-1', config),
    ]);

    expect(connectCalls).toBe(1);
    expect(first).toBe(second);
    expect(getMcpRuntimeStatus('user-1', 'server-1')).toEqual({
      status: 'connected',
      error: undefined,
    });
  });

  it('reuses the connected handle on later calls', async () => {
    let connectCalls = 0;
    setMcpClientConnectorForTest(() => {
      connectCalls += 1;
      return Promise.resolve(makeHandle());
    });

    const config = makeConfig('server-1');
    const first = await getMcpClient('user-1', config);
    const second = await getMcpClient('user-1', config);

    expect(connectCalls).toBe(1);
    expect(first).toBe(second);
  });

  it('keeps connections separate per user', async () => {
    let connectCalls = 0;
    setMcpClientConnectorForTest(() => {
      connectCalls += 1;
      return Promise.resolve(makeHandle());
    });

    const config = makeConfig('server-1');
    const a = await getMcpClient('user-a', config);
    const b = await getMcpClient('user-b', config);

    expect(connectCalls).toBe(2);
    expect(a).not.toBe(b);
  });

  it('records connect failures and retries on next use', async () => {
    let connectCalls = 0;
    setMcpClientConnectorForTest(() => {
      connectCalls += 1;
      if (connectCalls === 1) return Promise.reject(new Error('refused'));
      return Promise.resolve(makeHandle());
    });

    const config = makeConfig('server-1');
    await expect(getMcpClient('user-1', config)).rejects.toThrow('refused');
    expect(getMcpRuntimeStatus('user-1', 'server-1')).toEqual({
      status: 'error',
      error: 'refused',
    });

    await getMcpClient('user-1', config);
    expect(connectCalls).toBe(2);
    expect(getMcpRuntimeStatus('user-1', 'server-1').status).toBe('connected');
  });

  it('dispose closes the handle and the next use reconnects', async () => {
    let connectCalls = 0;
    let closed = 0;
    setMcpClientConnectorForTest(() => {
      connectCalls += 1;
      return Promise.resolve(makeHandle(() => closed++));
    });

    const config = makeConfig('server-1');
    await getMcpClient('user-1', config);
    await disposeMcpServer('user-1', 'server-1');

    expect(closed).toBe(1);
    expect(getMcpRuntimeStatus('user-1', 'server-1')).toEqual({ status: 'disconnected' });

    await getMcpClient('user-1', config);
    expect(connectCalls).toBe(2);
  });

  it('dispose during a connect closes the client once it lands', async () => {
    let closed = 0;
    setMcpClientConnectorForTest(async () => {
      await Bun.sleep(20);
      return makeHandle(() => closed++);
    });

    const config = makeConfig('server-1');
    const pending = getMcpClient('user-1', config);
    await disposeMcpServer('user-1', 'server-1');
    await pending;
    await Bun.sleep(0);

    expect(closed).toBe(1);
  });

  it('a dropped session flips status to disconnected and reconnects on use', async () => {
    let connectCalls = 0;
    const sessionClosers: Array<() => void> = [];
    setMcpClientConnectorForTest(
      (_config: McpServerRuntimeConfig, options?: ConnectMcpClientOptions) => {
        connectCalls += 1;
        if (options?.onSessionClosed) sessionClosers.push(options.onSessionClosed);
        return Promise.resolve(makeHandle());
      }
    );

    const config = makeConfig('server-1');
    await getMcpClient('user-1', config);
    sessionClosers[0]?.();

    expect(getMcpRuntimeStatus('user-1', 'server-1').status).toBe('disconnected');

    await getMcpClient('user-1', config);
    expect(connectCalls).toBe(2);
    expect(getMcpRuntimeStatus('user-1', 'server-1').status).toBe('connected');
  });

  it('closeAllMcpClients closes every held connection', async () => {
    let closed = 0;
    setMcpClientConnectorForTest(() => Promise.resolve(makeHandle(() => closed++)));

    await getMcpClient('user-1', makeConfig('server-1'));
    await getMcpClient('user-2', makeConfig('server-2'));

    await closeAllMcpClients();

    expect(closed).toBe(2);
    expect(getMcpRuntimeStatus('user-1', 'server-1')).toEqual({ status: 'disconnected' });
    expect(getMcpRuntimeStatus('user-2', 'server-2')).toEqual({ status: 'disconnected' });
  });
});
