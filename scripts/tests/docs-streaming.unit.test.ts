import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';

const encoder = new TextEncoder();
const textEvent = { type: 'text', text: 'Olá 👋', done: false };
const terminalEvent = { type: 'done', done: true };
const wire = `: keepalive\n\ndata: ${JSON.stringify(textEvent)}\n\ndata: ${JSON.stringify(terminalEvent)}\n\n`;

/** Executes the documentation's actual Fetch example against a byte stream. */
async function runExample(locale: string, chunks: Uint8Array[]): Promise<unknown[]> {
  const guide = readFileSync(
    new URL(`../../docs/${locale}architecture/streaming.md`, import.meta.url),
    'utf8'
  );
  const example =
    guide.split('### Service Layer')[1]?.match(/```typescript\n([\s\S]*?)```/)?.[1] ??
    guide.split('### Camada De Serviço')[1]?.match(/```typescript\n([\s\S]*?)```/)?.[1];
  if (!example) throw new Error('Expected the streaming Fetch example');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const bytes of chunks) controller.enqueue(bytes);
      controller.close();
    },
  });
  const events: unknown[] = [];
  const execute = compileFunction(
    `return (async () => {${new Bun.Transpiler({ loader: 'ts' }).transformSync(example)}})()`,
    ['fetch', 'request', 'signal', 'onChunk']
  );
  await execute(
    // eslint-disable-next-line @typescript-eslint/require-await -- This fake implements an asynchronous test dependency without external I/O.
    async () => new Response(stream),
    {},
    undefined,
    (event: unknown) => events.push(event)
  );
  return events;
}

for (const locale of ['', 'pt-br/']) {
  describe(`streaming documentation ${locale || 'en'}`, () => {
    test('delivers whole frames', async () => {
      expect(await runExample(locale, [encoder.encode(wire)])).toEqual([textEvent, terminalEvent]);
    });
    test('retains a data prefix split between chunks', async () => {
      const offset = wire.indexOf('data:') + 3;
      expect(
        await runExample(locale, [
          encoder.encode(wire.slice(0, offset)),
          encoder.encode(wire.slice(offset)),
        ])
      ).toEqual([textEvent, terminalEvent]);
    });
    test('retains split JSON and multibyte UTF-8', async () => {
      const bytes = encoder.encode(wire);
      expect(
        await runExample(
          locale,
          Array.from(bytes, (byte) => new Uint8Array([byte]))
        )
      ).toEqual([textEvent, terminalEvent]);
    });
    test('accepts CRLF frames and ignores keepalive comments', async () => {
      expect(await runExample(locale, [encoder.encode(wire.replaceAll('\n', '\r\n'))])).toEqual([
        textEvent,
        terminalEvent,
      ]);
    });
    test('rejects EOF without a terminal event', async () => {
      await expect(
        runExample(locale, [encoder.encode(`data: ${JSON.stringify(textEvent)}\n\n`)])
      ).rejects.toThrow('Stream ended before a terminal event');
    });
    test('does not dispatch a truncated final frame', async () => {
      await expect(runExample(locale, [encoder.encode('data: {"type":"text"')])).rejects.toThrow(
        'Stream ended before a terminal event'
      );
    });
  });
}
