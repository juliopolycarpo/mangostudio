import { describe, expect, it } from 'bun:test';
import { StdioJsonRpcClient } from '../../../src/services/external-agents/jsonrpc';
import type { ExternalAgentManagedProcess } from '../../../src/services/external-agents/process';

/**
 * A vendor process whose stdin is gone, which is what a child that died between
 * one request and the next looks like from here.
 */
function brokenStdinProcess(): ExternalAgentManagedProcess {
  let ended = false;
  return {
    pid: -1,
    stdout: {
      next: async (timeoutMs) => {
        if (ended) return { kind: 'eof' } as const;
        await Bun.sleep(Math.min(timeoutMs, 5));
        return { kind: 'timeout' } as const;
      },
      close: () => {
        ended = true;
      },
    },
    exit: Promise.resolve({ code: 1, signal: null }),
    writeLine: () => Promise.reject(new Error('EPIPE: the vendor process is gone')),
    stderrTail: () => '',
    terminate: () => Promise.resolve(),
  };
}

/** Runs `body` and reports any unhandled rejection it produced. */
async function withUnhandledRejectionWatch(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
    // Unhandled rejections are reported a turn of the loop after the fact, so
    // a watch that stops immediately would never see one.
    await Bun.sleep(20);
    Bun.gc(true);
    await Bun.sleep(20);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

describe('stdio json-rpc — a request whose write never lands', () => {
  it('fails the call without orphaning it', async () => {
    const client = new StdioJsonRpcClient(
      brokenStdinProcess(),
      {
        onNotification: () => undefined,
        onServerRequest: () => ({ result: null }),
      },
      'Codex app-server'
    );

    const unhandled = await withUnhandledRejectionWatch(async () => {
      await expect(client.request('thread/start', {}, 1_000)).rejects.toThrow(/EPIPE/);
      // `close` rejects everything still pending. A call whose write failed is
      // not pending — it already failed — so nothing here has a second, ownerless
      // rejection waiting to escape and take the runtime process down with it.
      await client.close();
    });

    expect(unhandled).toEqual([]);
  });
});
