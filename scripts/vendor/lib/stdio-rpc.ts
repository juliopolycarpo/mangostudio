/**
 * A minimal newline-delimited JSON-RPC client, for capture scripts only.
 *
 * Deliberately *not* the runtime's `StdioJsonRpcClient`. That one carries
 * cancellation, server-request routing, teardown ordering and a peer name for
 * diagnostics, all of which exist because a user's turn depends on them.
 * Reaching into `apps/runtime/src` from `scripts/` would also cross a workspace
 * boundary by relative path, which this repository does not do. What a capture
 * needs is narrower than either: send a request, wait for its reply, give up
 * after a while, kill the process.
 *
 * Every reply id is compared loosely on purpose. Cursor answers with numeric
 * ids, and pinning that here would make the capture fail on a vendor that
 * switched to strings — which is drift the *contract* should report, not a
 * crash in the tool that reports it.
 */

export interface StdioRpcSession {
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

export interface StdioRpcOptions {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Spawns the peer and returns a session that speaks to it over stdio. */
export function openStdioRpc(options: StdioRpcOptions): StdioRpcSession {
  const child = Bun.spawn({
    cmd: [...options.argv],
    cwd: options.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, (value: unknown) => void>();
  let nextId = 1;
  let closed = false;

  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // A peer that writes a banner to stdout is not a protocol error.
          continue;
        }
        const id = message.id;
        if (id === undefined || id === null) continue;
        const settle = pending.get(String(id));
        if (!settle) continue;
        pending.delete(String(id));
        settle('error' in message ? { __rpcError: message.error } : message.result);
      }
    }
  })().catch(() => undefined);

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error(`${method} requested after close.`));
      const id = nextId++;
      const key = String(id);
      const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      child.stdin.write(frame);
      child.stdin.flush();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.delete(key)) reject(new Error(`${method} did not answer in ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(key, (value) => {
          clearTimeout(timer);
          const failure = (value as { __rpcError?: unknown } | undefined)?.__rpcError;
          if (failure !== undefined) {
            reject(new Error(`${method} failed: ${JSON.stringify(failure)}`));
            return;
          }
          resolve(value);
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const settle of pending.values()) settle(undefined);
      pending.clear();
      try {
        child.stdin.end();
      } catch {
        // Already gone; the kill below is what matters.
      }
      child.kill();
      void pump;
    },
  };
}
