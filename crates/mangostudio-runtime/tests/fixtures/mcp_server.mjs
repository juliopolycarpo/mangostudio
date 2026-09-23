// A small raw JSON-RPC MCP server over stdio for the Rust runtime's own tests.
//
// It answers exactly the requests the tests exercise and, when MCP_FIXTURE_LOG names a file,
// appends every message it receives there as one JSON line, so a test can assert what crossed
// the runtime -> server boundary (the initialize frame, cancellation notices, elicitation
// answers).
//
// When MCP_FIXTURE_SHUTDOWN_LOG names a file, the server also records how it was asked to stop:
// `eof` when its stdin ends, `term` on SIGTERM, and `clean-exit` once it leaves on its own after a
// short unwind. MCP_FIXTURE_SHUTDOWN_MODE picks what it honours: `graceful` (default) exits after
// EOF or SIGTERM, `ignore-eof` exits only after SIGTERM, `stubborn` ignores both, so only a forced
// kill ends it. A SIGKILLed server never writes `clean-exit`. Each line is `<event> <epoch ms>`, so a
// test can also tell when SIGTERM came relative to end of input.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = process.env.MCP_FIXTURE_LOG;
const pending = new Map();
let nextId = 1;
const shutdownLog = process.env.MCP_FIXTURE_SHUTDOWN_LOG;
const shutdownMode = process.env.MCP_FIXTURE_SHUTDOWN_MODE ?? 'graceful';
const UNWIND_MS = 300;

function recordShutdown(event) {
  if (shutdownLog) appendFileSync(shutdownLog, `${event} ${Date.now()}\n`);
}

function unwindAndExit() {
  setTimeout(() => {
    recordShutdown('clean-exit');
    process.exit(0);
  }, UNWIND_MS);
}

if (shutdownLog) {
  process.on('SIGTERM', () => {
    recordShutdown('term');
    if (shutdownMode !== 'stubborn') unwindAndExit();
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function reply(id, result) {
  send({ id, result });
}

function ask(method, params) {
  const id = `server-${nextId++}`;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function text(value, extra = {}) {
  return { content: [{ type: 'text', text: value }], ...extra };
}

async function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === 'echo') return reply(id, text(String(args.text ?? '')));
  if (name === 'big') return reply(id, text('x'.repeat(200_000)));
  if (name === 'boom') return reply(id, text('tool exploded', { isError: true }));
  if (name === 'unusual') {
    return reply(id, { content: [{ type: 'video', mimeType: 'video/mp4', data: 'ignored' }] });
  }
  if (name === 'hang') return;
  if (name === 'crash') process.exit(1);
  if (name === 'notify') {
    send({ method: 'notifications/tools/list_changed' });
    return reply(id, text('notified'));
  }
  if (name === 'ask') {
    const answer = await ask('elicitation/create', {
      mode: 'form',
      message: 'Pick a tier',
      requestedSchema: {
        type: 'object',
        required: ['tier'],
        properties: { tier: { type: 'string', enum: ['free', 'pro'], enumNames: ['Free', 'Pro'] } },
      },
    });
    return reply(id, text(JSON.stringify(answer.result ?? answer.error)));
  }
  if (name === 'ask-order') {
    const answer = await ask('elicitation/create', {
      message: 'Ordered form',
      requestedSchema: {
        type: 'object',
        properties: { zeta: { type: 'string' }, alpha: { type: 'number' }, mid: { type: 'boolean' } },
      },
    });
    return reply(id, text(JSON.stringify(answer.result ?? answer.error)));
  }
  if (name === 'ask-url') {
    const answer = await ask('elicitation/create', {
      mode: 'url',
      message: 'Open this',
      url: 'https://example.test/consent',
      elicitationId: 'url-1',
    });
    return reply(id, text(JSON.stringify(answer.result ?? answer.error)));
  }
  if (name === 'ask-withdraw') {
    const requestId = `server-${nextId}`;
    const asked = ask('elicitation/create', {
      message: 'Withdrawn soon',
      requestedSchema: { type: 'object', properties: {} },
    });
    setTimeout(() => send({ method: 'notifications/cancelled', params: { requestId } }), 50);
    const answer = await Promise.race([asked, new Promise((done) => setTimeout(done, 1000, null))]);
    return reply(id, text(answer === null ? 'withdrawn' : JSON.stringify(answer.result)));
  }
  send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, `${line}\n`);
  if (!('method' in message)) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    continue;
  }
  if (!('id' in message)) continue;
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      serverInfo: { name: 'mango-mcp-test', version: '1.0.0' },
    });
  } else if (method === 'tools/list') {
    const second = params?.cursor === 'next';
    reply(id, {
      tools: [
        {
          name: second ? 'second' : 'first',
          description: second ? 'Second page' : 'First page',
          inputSchema: { type: 'object' },
        },
      ],
      ...(second ? {} : { nextCursor: 'next' }),
    });
  } else if (method === 'tools/call') {
    void callTool(id, params);
  } else if (method === 'resources/list') {
    const second = params?.cursor === 'r2';
    reply(id, {
      resources: second
        ? [{ uri: 'file:///two', name: 'two', mimeType: 'text/plain', size: 3 }]
        : [{ uri: 'file:///one', name: 'one', title: 'One' }],
      ...(second ? {} : { nextCursor: 'r2' }),
    });
  } else if (method === 'resources/read') {
    reply(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: `content of ${params.uri}` }] });
  } else if (method === 'prompts/list') {
    reply(id, {
      prompts: [{ name: 'greet', description: 'Say hi', arguments: [{ name: 'who', required: true }] }],
    });
  } else if (method === 'prompts/get') {
    reply(id, {
      description: 'Greeting',
      messages: [{ role: 'user', content: { type: 'text', text: `Hello ${params.arguments?.who}` } }],
    });
  } else {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

if (shutdownLog) {
  recordShutdown('eof');
  if (shutdownMode === 'graceful') unwindAndExit();
  else setInterval(() => {}, 1_000);
}
