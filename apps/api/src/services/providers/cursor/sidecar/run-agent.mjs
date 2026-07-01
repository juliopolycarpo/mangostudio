#!/usr/bin/env node
/**
 * Node sidecar for Cursor SDK local agent runs.
 * Reads a JSON request from stdin and writes NDJSON events to stdout.
 */

import { Agent, CursorAgentError } from '@cursor/sdk';

const MAX_STDIN_BYTES = 2 * 1024 * 1024;

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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

  await using agent = await Agent.create({
    apiKey,
    model: { id: model, ...(modelParams ? { params: modelParams } : {}) },
    local: {
      cwd,
      settingSources: [],
    },
  });

  const run = await agent.send(prompt);

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
