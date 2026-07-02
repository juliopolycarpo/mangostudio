#!/usr/bin/env node
/**
 * Node sidecar for Cursor SDK local agent runs.
 * The first stdout line is the `ready` handshake; line 1 on stdin is the JSON
 * request; subsequent stdin lines are tool_response RPC messages. Writes
 * NDJSON events (and tool_request RPC) to stdout.
 */

import { createInterface } from 'node:readline';
import { Agent, Cursor } from '@cursor/sdk';

/**
 * NDJSON protocol version announced in the `ready` handshake. Must stay in
 * lockstep with CURSOR_SIDECAR_PROTOCOL_VERSION in ../sidecar-process.ts
 * (this script cannot import it — both ship inside the same artifact).
 */
const PROTOCOL_VERSION = 1;

/** Tool RPC wait applied when the parent does not pass toolRpcTimeoutMs. */
const DEFAULT_TOOL_RPC_TIMEOUT_MS = 300_000;

// If the parent dies mid-run, stdout writes raise EPIPE; swallow so cleanup
// paths (agent disposal, exit handlers) still run instead of crashing.
process.stdout.on('error', () => {});

function writeEvent(event) {
  try {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  } catch {
    // Parent may be gone (EPIPE); nothing useful to do.
  }
}

function isRecord(value) {
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

function serializeError(error, fallback) {
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

function normalizeCustomTools(value) {
  if (!Array.isArray(value)) return undefined;

  const tools = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    tools.push({
      name,
      description:
        typeof item.description === 'string' && item.description.trim()
          ? item.description
          : `MangoStudio tool: ${name}`,
      inputSchema: isRecord(item.inputSchema) ? item.inputSchema : { type: 'object' },
    });
  }

  return tools.length > 0 ? tools : undefined;
}

function normalizeSettingSources(value) {
  if (!Array.isArray(value)) return ['project'];
  const sources = value.filter((entry) => typeof entry === 'string' && entry.trim());
  return sources.length > 0 ? sources : ['project'];
}

function createStdinMultiplexer() {
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
        content: 'Cursor sidecar stdin closed before a request was received.',
        done: true,
      });
      process.exit(1);
    }

    // Mid-run stdin close: no tool_response can ever arrive; unblock callers.
    rejectPendingToolWaiters(
      toolWaiters,
      new Error('Cursor sidecar stdin closed while a tool call was pending.')
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

function normalizeToolRpcTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOOL_RPC_TIMEOUT_MS;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : DEFAULT_TOOL_RPC_TIMEOUT_MS;
}

let nextToolRequestId = 0;

function createRpcBackedCustomTools(toolDefs, stdinMux) {
  return Object.fromEntries(
    toolDefs.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (args) => executeViaApi(tool.name, args, stdinMux),
      },
    ])
  );
}

async function executeViaApi(name, args, stdinMux) {
  const id = `mango-tool-${++nextToolRequestId}`;
  const safeArgs = isRecord(args) ? args : {};

  writeEvent({ type: 'tool_request', id, name, args: safeArgs });

  const response = await stdinMux.waitForToolResponse(id);
  if (response.isError) {
    const message =
      typeof response.error === 'string'
        ? response.error
        : typeof response.result === 'string'
          ? response.result
          : 'Tool execution failed.';
    writeEvent({ type: 'tool_result', id, name, result: message, isError: true });
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }

  const result = response.result === undefined ? '' : response.result;
  writeEvent({ type: 'tool_result', id, name, result, isError: false });
  return result;
}

function extractAssistantText(event) {
  if (event.type !== 'assistant') return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;

  const textParts = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .filter(Boolean);

  if (textParts.length === 0) return null;
  return textParts.join('');
}

function shouldEmitToolCall(event, emittedToolCalls) {
  if (event.status === 'running') return false;

  const callId = typeof event.call_id === 'string' ? event.call_id.trim() : '';
  if (!callId) return true;
  if (emittedToolCalls.has(callId)) return false;

  emittedToolCalls.add(callId);
  return true;
}

async function disposeAgent(agent) {
  const asyncDispose = agent?.[Symbol.asyncDispose];
  if (typeof asyncDispose === 'function') {
    await asyncDispose.call(agent);
    return;
  }

  const dispose = agent?.[Symbol.dispose];
  if (typeof dispose === 'function') {
    dispose.call(agent);
  }
}

/**
 * The agent currently running, tracked so the SIGTERM handler can dispose it
 * (releasing Cursor's native child process) before exiting. Disposal is
 * idempotent: SIGTERM and runAgent's finally may both reach it.
 */
let activeAgent;
let activeAgentDisposed = false;

async function disposeActiveAgent() {
  if (!activeAgent || activeAgentDisposed) return;
  activeAgentDisposed = true;
  await disposeAgent(activeAgent);
}

process.on('SIGTERM', () => {
  disposeActiveAgent()
    .catch(() => {})
    .finally(() => process.exit(143));
});

function readApiKey(request) {
  const apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
  if (!apiKey) throw new Error('Sidecar request missing apiKey.');
  return apiKey;
}

function normalizeModelList(models) {
  if (!Array.isArray(models)) return [];

  return models.map((model) => ({
    ...(typeof model?.id === 'string' ? { id: model.id } : {}),
    ...(Array.isArray(model?.parameters) ? { parameters: model.parameters } : {}),
  }));
}

async function listModels(request) {
  const models = await Cursor.models.list({ apiKey: readApiKey(request) });
  writeEvent({ type: 'models', models: normalizeModelList(models) });
}

async function validateApiKey(request) {
  await Cursor.models.list({ apiKey: readApiKey(request) });
  writeEvent({ type: 'ok' });
}

async function runAgent(request, stdinMux) {
  stdinMux.setToolRpcTimeoutMs(request.toolRpcTimeoutMs);

  const apiKey = readApiKey(request);
  const model = typeof request.model === 'string' ? request.model.trim() : '';
  const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';

  if (!model) throw new Error('Sidecar request missing model.');
  if (!cwd) throw new Error('Sidecar request missing cwd.');
  if (!prompt.trim()) throw new Error('Sidecar request missing prompt.');

  const modelParams = Array.isArray(request.params) ? request.params : undefined;
  const toolDefs = normalizeCustomTools(request.customTools);
  const customTools = toolDefs ? createRpcBackedCustomTools(toolDefs, stdinMux) : undefined;
  const settingSources = normalizeSettingSources(request.settingSources);

  try {
    activeAgent = await Agent.create({
      apiKey,
      model: { id: model, ...(modelParams ? { params: modelParams } : {}) },
      local: {
        cwd,
        settingSources,
        ...(customTools ? { customTools } : {}),
      },
    });
    const agent = activeAgent;

    const run = await agent.send(prompt);
    const emittedToolCalls = new Set();

    for await (const event of run.stream()) {
      if (event.type === 'assistant') {
        const text = extractAssistantText(event);
        if (text) {
          writeEvent({ type: 'text', text });
        }
        continue;
      }

      if (event.type === 'thinking' && typeof event.text === 'string' && event.text) {
        writeEvent({ type: 'thinking', text: event.text });
        continue;
      }

      if (event.type === 'tool_call') {
        if (!shouldEmitToolCall(event, emittedToolCalls)) continue;
        writeEvent({
          type: 'tool_call',
          callId: event.call_id,
          name: event.name,
          status: event.status,
          args: event.args,
          result: event.result,
        });
      }
    }

    const result = await run.wait();

    if (result.status === 'error') {
      writeEvent({ type: 'error', content: `Cursor agent run failed (${result.id}).`, done: true });
      process.exitCode = 2;
      return;
    }

    writeEvent({ type: 'done', done: true });
  } finally {
    await disposeActiveAgent();
  }
}

async function main() {
  writeEvent({ type: 'ready', protocolVersion: PROTOCOL_VERSION });

  const stdinMux = createStdinMultiplexer();
  const request = await stdinMux.readRequest();
  if (!isRecord(request)) throw new Error('Sidecar request must be a JSON object.');

  const type = typeof request.type === 'string' ? request.type : 'run_agent';
  try {
    switch (type) {
      case 'run_agent':
        await runAgent(request, stdinMux);
        return;
      case 'list_models':
        await listModels(request);
        return;
      case 'validate_api_key':
        await validateApiKey(request);
        return;
      default:
        throw new Error(`Unsupported Cursor sidecar request type "${type}".`);
    }
  } finally {
    stdinMux.close();
  }
}

main().catch((error) => {
  writeEvent({
    type: 'error',
    ...serializeError(error, 'Cursor sidecar failed.'),
    done: true,
  });
  process.exitCode = 1;
});
