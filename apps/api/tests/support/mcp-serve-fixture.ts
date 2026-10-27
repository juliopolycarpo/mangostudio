import { dialDeadline } from '@mangostudio/shared/utils/dial-deadline';

import { type RustServeRuntime, startRustServe } from './rust-serve-runtime';

interface McpServeFixtureOptions {
  readonly label: string;
  readonly token: string;
  readonly connect: (runtime: RustServeRuntime, signal: AbortSignal) => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

interface McpServeFixtureDependencies {
  readonly start: typeof startRustServe;
  readonly deadline: typeof dialDeadline;
}

/**
 * Owns serve and Hub setup under one 10-second startup budget, including health and WebSocket.
 * @example
 * const fixture = await startMcpServeFixture(binary.path, { label, token, connect, disconnect });
 * try { await qualifyMcp(); } finally { await fixture.close(); }
 */
export async function startMcpServeFixture(
  binaryPath: string,
  options: McpServeFixtureOptions,
  dependencies: McpServeFixtureDependencies = { start: startRustServe, deadline: dialDeadline }
): Promise<{ close(): Promise<void> }> {
  const deadline = dependencies.deadline(10_000, 'MCP serve fixture startup exceeded 10000ms');
  let runtime: RustServeRuntime | undefined;
  const close = async () => {
    const results = await Promise.allSettled([options.disconnect(), runtime?.close()]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };
  try {
    runtime = await dependencies.start(binaryPath, {
      label: options.label,
      token: options.token,
      signal: deadline.signal,
    });
    deadline.signal.throwIfAborted();
    await options.connect(runtime, deadline.signal);
    deadline.signal.throwIfAborted();
    return { close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  } finally {
    deadline.clear();
  }
}
