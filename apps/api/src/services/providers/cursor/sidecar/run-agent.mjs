#!/usr/bin/env node
/**
 * Node sidecar for Cursor SDK local agent runs.
 * Line 1 on stdin is the JSON request; subsequent lines are tool_response RPC messages.
 * Writes NDJSON events (and tool_request RPC) to stdout.
 */

import { createInterface } from 'node:readline';
import { Agent, CursorAgentError } from '@cursor/sdk';

const TOOL_RPC_TIMEOUT_MS = 30_000;

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  let requestResolve;
  let gotRequest = false;

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
        clearTimeout(waiter.timeout);
        waiter.resolve(parsed);
      }
    }
  });

  return {
    readRequest: () => requestPromise,
    waitForToolResponse(id) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          toolWaiters.delete(id);
          reject(new Error(`Tool RPC timed out after ${TOOL_RPC_TIMEOUT_MS}ms.`));
        }, TOOL_RPC_TIMEOUT_MS);
        timeout.unref?.();
        toolWaiters.set(id, { resolve, reject, timeout });
      });
    },
    close: () => rl.close(),
  };
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
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }

  if (typeof response.result === 'string') return response.result;
  if (response.result !== undefined) return response.result;
  return '';
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

async function main() {
  const stdinMux = createStdinMultiplexer();
  const request = await stdinMux.readRequest();

  const apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
  const model = typeof request.model === 'string' ? request.model.trim() : '';
  const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';

  if (!apiKey) throw new Error('Sidecar request missing apiKey.');
  if (!model) throw new Error('Sidecar request missing model.');
  if (!cwd) throw new Error('Sidecar request missing cwd.');
  if (!prompt.trim()) throw new Error('Sidecar request missing prompt.');

  const modelParams = Array.isArray(request.params) ? request.params : undefined;
  const toolDefs = normalizeCustomTools(request.customTools);
  const customTools = toolDefs ? createRpcBackedCustomTools(toolDefs, stdinMux) : undefined;
  const settingSources = normalizeSettingSources(request.settingSources);

  await using agent = await Agent.create({
    apiKey,
    model: { id: model, ...(modelParams ? { params: modelParams } : {}) },
    local: {
      cwd,
      settingSources,
      ...(customTools ? { customTools } : {}),
    },
  });

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
  stdinMux.close();

  if (result.status === 'error') {
    writeEvent({ type: 'error', content: `Cursor agent run failed (${result.id}).`, done: true });
    process.exitCode = 2;
    return;
  }

  writeEvent({ type: 'done', done: true });
}

main().catch((error) => {
  if (error instanceof CursorAgentError) {
    writeEvent({
      type: 'error',
      content: error.message,
      retryable: error.isRetryable,
      done: true,
    });
    process.exitCode = 1;
    return;
  }

  writeEvent({
    type: 'error',
    content: error instanceof Error ? error.message : 'Cursor sidecar failed.',
    done: true,
  });
  process.exitCode = 1;
});
