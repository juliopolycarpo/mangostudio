#!/usr/bin/env node
/**
 * Node sidecar for Cursor SDK local agent runs.
 * Reads a JSON request from stdin and writes NDJSON events to stdout.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Agent, CursorAgentError } from '@cursor/sdk';

const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const SHELL_TOOL_NAMES = new Set(['bash', 'zsh', 'powershell']);
const DEFAULT_SHELL_TIMEOUT_MS = 15_000;
const MIN_SHELL_TIMEOUT_MS = 1_000;
const MAX_SHELL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100_000;
const MIN_MAX_OUTPUT_BYTES = 1_000;
const MAX_MAX_OUTPUT_BYTES = 1_000_000;

const DEFAULT_SHELL_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      description: 'Command to execute.',
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory. Absolute path or one starting with ~.',
    },
  },
  required: ['command'],
  additionalProperties: false,
};

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function readStdinJson() {
  const chunks = [];
  let total = 0;

  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error('Sidecar request exceeded maximum stdin size.');
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error('Sidecar request body is empty.');
  }

  return JSON.parse(raw);
}

function normalizeShellTools(value) {
  if (!Array.isArray(value)) return undefined;

  const tools = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    const kind = typeof item.kind === 'string' ? item.kind : '';
    const executable = typeof item.executable === 'string' ? item.executable.trim() : '';
    if (!SHELL_TOOL_NAMES.has(kind) || !executable) continue;

    tools.push({
      kind,
      executable,
      description:
        typeof item.description === 'string' && item.description.trim()
          ? item.description
          : `Runs a command with ${kind}.`,
      inputSchema: isRecord(item.inputSchema) ? item.inputSchema : DEFAULT_SHELL_SCHEMA,
      timeoutMs: clampInteger(
        item.timeoutMs,
        DEFAULT_SHELL_TIMEOUT_MS,
        MIN_SHELL_TIMEOUT_MS,
        MAX_SHELL_TIMEOUT_MS
      ),
      maxOutputBytes: clampInteger(
        item.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        MIN_MAX_OUTPUT_BYTES,
        MAX_MAX_OUTPUT_BYTES
      ),
    });
  }

  return tools.length > 0 ? tools : undefined;
}

function createShellCustomTools(shellTools) {
  if (!shellTools) return undefined;

  return Object.fromEntries(
    shellTools.map((tool) => [
      tool.kind,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (args) => runShellCommand(tool, args),
      },
    ])
  );
}

async function runShellCommand(tool, args) {
  const command = isRecord(args) && typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) throw new Error('Missing required command.');

  const cwd =
    isRecord(args) && typeof args.cwd === 'string' ? resolveWorkingDirectory(args.cwd) : undefined;
  const startedAt = Date.now();
  let timedOut = false;

  let child;
  try {
    child = spawn(tool.executable, buildShellInvocation(tool.kind, command), {
      ...(cwd ? { cwd } : {}),
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`Cannot run ${tool.kind} command: ${formatError(error)}`);
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, tool.timeoutMs);
  timeout.unref?.();

  try {
    const [stdout, stderr, exitStatus] = await Promise.all([
      readStreamCapped(child.stdout, tool.maxOutputBytes),
      readStreamCapped(child.stderr, tool.maxOutputBytes),
      waitForChildExit(child),
    ]);

    return {
      shell: tool.kind,
      command,
      exitCode: exitStatus.code,
      signal: exitStatus.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildShellInvocation(kind, command) {
  if (kind === 'powershell') {
    return ['-NoProfile', '-NonInteractive', '-Command', command];
  }
  return ['-c', command];
}

function resolveWorkingDirectory(cwd) {
  const text = cwd.trim();
  if (!text) return undefined;
  return resolve(expandHome(text));
}

function expandHome(path) {
  if (path === '~' || path.startsWith('~/')) {
    const home = process.env.HOME || homedir();
    if (!home) return path;
    if (path === '~') return home;
    return `${home}/${path.slice(2)}`;
  }
  return path;
}

function readStreamCapped(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let truncated = false;

    stream.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      if (total < maxBytes) {
        chunks.push(buffer);
        total += buffer.byteLength;
        if (total > maxBytes) truncated = true;
        return;
      }
      truncated = true;
    });
    stream.once('error', reject);
    stream.once('end', () => {
      const merged = Buffer.concat(chunks);
      resolve({ text: merged.subarray(0, maxBytes).toString('utf8'), truncated });
    });
  });
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', (error) =>
      reject(new Error(`Cannot run shell command: ${formatError(error)}`))
    );
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
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
  const request = await readStdinJson();
  const apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
  const model = typeof request.model === 'string' ? request.model.trim() : '';
  const cwd = typeof request.cwd === 'string' ? request.cwd.trim() : '';
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';

  if (!apiKey) throw new Error('Sidecar request missing apiKey.');
  if (!model) throw new Error('Sidecar request missing model.');
  if (!cwd) throw new Error('Sidecar request missing cwd.');
  if (!prompt.trim()) throw new Error('Sidecar request missing prompt.');

  const modelParams = Array.isArray(request.params) ? request.params : undefined;
  const customTools = createShellCustomTools(normalizeShellTools(request.shellTools));

  await using agent = await Agent.create({
    apiKey,
    model: { id: model, ...(modelParams ? { params: modelParams } : {}) },
    local: {
      cwd,
      settingSources: [],
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
