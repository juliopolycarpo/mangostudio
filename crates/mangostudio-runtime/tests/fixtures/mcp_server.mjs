import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const message = JSON.parse(line);
  if (!('id' in message)) continue;

  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'mango-mcp-test', version: '1.0.0' },
      },
    })}\n`);
    continue;
  }

  if (message.method === 'tools/list') {
    const second = message.params?.cursor === 'next';
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: second ? 'second' : 'first',
          description: second ? 'Second page' : 'First page',
          inputSchema: { type: 'object' },
        }],
        ...(second ? {} : { nextCursor: 'next' }),
      },
    })}\n`);
  }
}
