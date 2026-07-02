/**
 * Shared Node-side helpers for MangoStudio SDK sidecars.
 *
 * This file is plain ESM because it ships beside sidecar entrypoints and
 * cannot import workspace TypeScript.
 */

import { createInterface } from 'node:readline';

/** Tool RPC wait applied when the parent does not pass toolRpcTimeoutMs. */
export const DEFAULT_TOOL_RPC_TIMEOUT_MS = 300_000;

// If the parent dies mid-run, stdout writes raise EPIPE; swallow so cleanup
// paths (agent disposal, exit handlers) still run instead of crashing.
process.stdout.on('error', () => {});

export function writeEvent(event) {
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {
    // Parent may be gone (EPIPE); nothing useful to do.
  }
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorStatus(error) {
  if (!isRecord(error)) return undefined;
  const status = error.status ?? error.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorRetryable(error) {
  if (!isRecord(error)) return undefined;
  return typeof error.isRetryable === 'boolean' ? error.isRetryable : undefined;
}

export function serializeError(error, fallback) {
  const message = error instanceof Error && error.message ? error.message : fallback;
  const status = errorStatus(error);
  const isRetryable = errorRetryable(error);
  return {
    message,
    content: message,
    ...(status === undefined ? {} : { status }),
    ...(isRetryable === undefined ? {} : { isRetryable, retryable: isRetryable }),
  };
}

export function createStdinMultiplexer(options = {}) {
  const sidecarLabel = typeof options.sidecarLabel === 'string' ? options.sidecarLabel : 'Node';
  const rl = createInterface({ input: process.stdin });
  const toolWaiters = new Map();
  let toolRpcTimeoutMs = DEFAULT_TOOL_RPC_TIMEOUT_MS;
  let requestResolve;
  let gotRequest = false;
  let closedByUs = false;

  const requestPromise = new Promise((resolve) => {
    requestResolve = resolve;
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!gotRequest) {
      gotRequest = true;
      requestResolve(parsed);
      return;
    }

    if (parsed?.type === 'tool_response' && typeof parsed.id === 'string') {
      const waiter = toolWaiters.get(parsed.id);
      if (waiter) {
        toolWaiters.delete(parsed.id);
        if (waiter.timeout) clearTimeout(waiter.timeout);
        waiter.resolve(parsed);
      }
    }
  });

  rl.on('close', () => {
    if (closedByUs) return;

    // Parent died before sending a request: exit instead of idling forever.
    if (!gotRequest) {
      writeEvent({
        type: 'error',
        content: `${sidecarLabel} sidecar stdin closed before a request was received.`,
        done: true,
      });
      process.exit(1);
    }

    // Mid-run stdin close: no tool_response can ever arrive; unblock callers.
    rejectPendingToolWaiters(
      toolWaiters,
      new Error(`${sidecarLabel} sidecar stdin closed while a tool call was pending.`)
    );
  });

  return {
    readRequest: () => requestPromise,
    setToolRpcTimeoutMs(value) {
      toolRpcTimeoutMs = normalizeToolRpcTimeoutMs(value);
    },
    waitForToolResponse(id) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          toolWaiters.delete(id);
          reject(new Error(`Tool RPC timed out after ${toolRpcTimeoutMs}ms.`));
        }, toolRpcTimeoutMs);
        timeout.unref?.();
        toolWaiters.set(id, { resolve, reject, timeout });
      });
    },
    close: () => {
      closedByUs = true;
      rl.close();
    },
  };
}

function rejectPendingToolWaiters(toolWaiters, error) {
  for (const [id, waiter] of toolWaiters) {
    toolWaiters.delete(id);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
}

export function normalizeToolRpcTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOOL_RPC_TIMEOUT_MS;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : DEFAULT_TOOL_RPC_TIMEOUT_MS;
}
