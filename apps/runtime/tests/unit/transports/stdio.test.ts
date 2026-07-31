import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { RuntimeCapabilityManifest, RuntimeFrame } from '@mangostudio/shared/runtime-protocol';
import { createStdioFramePort, type StdioFramePortClosure } from '../../../src';
import { RuntimeProtocolClient } from '../../../src/client';
import { RuntimeHost } from '../../../src/host';

const manifest: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

interface StdioHarness {
  readonly frames: RuntimeFrame[];
  readonly closures: StdioFramePortClosure[];
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly port: ReturnType<typeof createStdioFramePort>;
  outputText(): string;
}

function createHarness(options: { readonly maxFrameBytes?: number } = {}): StdioHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: RuntimeFrame[] = [];
  const closures: StdioFramePortClosure[] = [];
  let outputText = '';
  output.on('data', (chunk: Buffer) => {
    outputText += chunk.toString('utf8');
  });

  const port = createStdioFramePort({
    input,
    output,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    onClosed: (closure) => closures.push(closure),
  });
  port.onFrame((frame) => frames.push(frame));

  return { frames, closures, input, output, port, outputText: () => outputText };
}

describe('stdio frame port', () => {
  it('reassembles a frame torn across chunk boundaries', async () => {
    const harness = createHarness();
    const line = `${JSON.stringify({ type: 'ping' })}\n`;

    harness.input.write(line.slice(0, 4));
    harness.input.write(line.slice(4, 9));
    harness.input.write(line.slice(9));
    await Bun.sleep(0);

    expect(harness.frames).toEqual([{ type: 'ping' }]);
    expect(harness.closures).toEqual([]);
  });

  it('delivers several frames arriving in one chunk', async () => {
    const harness = createHarness();

    harness.input.write(
      `${JSON.stringify({ type: 'ping' })}\n${JSON.stringify({ type: 'pong' })}\n`
    );
    await Bun.sleep(0);

    expect(harness.frames).toEqual([{ type: 'ping' }, { type: 'pong' }]);
  });

  it('accepts a final record that arrives without its newline', async () => {
    const harness = createHarness();

    harness.input.end(JSON.stringify({ type: 'ping' }));
    await Bun.sleep(0);

    expect(harness.frames).toEqual([{ type: 'ping' }]);
    expect(harness.closures).toEqual([{ kind: 'eof' }]);
  });

  it('tears the connection down on a record that is not valid JSON', async () => {
    const harness = createHarness();

    harness.input.write('{"type":"ping"\n');
    await Bun.sleep(0);

    expect(harness.frames).toEqual([]);
    expect(harness.closures).toHaveLength(1);
    expect(harness.closures[0]).toMatchObject({ kind: 'protocol-error' });
    expect(() => harness.port.send({ type: 'ping' })).toThrow('Runtime stdio port is closed.');
  });

  it('tears the connection down on a record the schema rejects', async () => {
    const harness = createHarness();

    harness.input.write(`${JSON.stringify({ type: 'nope' })}\n`);
    await Bun.sleep(0);

    expect(harness.closures[0]).toMatchObject({ kind: 'protocol-error' });
  });

  it('never skips past a bad record to a good one behind it', async () => {
    const harness = createHarness();

    harness.input.write(`not json\n${JSON.stringify({ type: 'ping' })}\n`);
    await Bun.sleep(0);

    expect(harness.frames).toEqual([]);
  });

  it('refuses an inbound record past the line-length cap', async () => {
    const harness = createHarness({ maxFrameBytes: 64 });

    harness.input.write(
      `${JSON.stringify({ type: 'req', id: 'a', method: 'snapshot.hash', params: { path: 'x'.repeat(200) } })}\n`
    );
    await Bun.sleep(0);

    expect(harness.closures[0]).toMatchObject({ kind: 'protocol-error' });
    expect((harness.closures[0] as { error: Error }).error.message).toContain('line limit');
  });

  it('refuses an outbound record past the line-length cap without closing', () => {
    const harness = createHarness({ maxFrameBytes: 64 });

    expect(() =>
      harness.port.send({
        type: 'req',
        id: 'a',
        method: 'snapshot.hash',
        params: { path: 'x'.repeat(200) },
      })
    ).toThrow('line limit');
    expect(harness.closures).toEqual([]);
  });

  it('writes one newline-terminated record per frame', () => {
    const harness = createHarness();

    harness.port.send({ type: 'ping' });
    harness.port.send({ type: 'pong' });

    expect(harness.outputText()).toBe('{"type":"ping"}\n{"type":"pong"}\n');
  });

  it('stays silent when its owner closes it', async () => {
    const harness = createHarness();

    harness.port.close();
    harness.input.end(`${JSON.stringify({ type: 'ping' })}\n`);
    await Bun.sleep(0);

    expect(harness.closures).toEqual([]);
    expect(harness.frames).toEqual([]);
  });

  it('carries a full handshake and request between two piped ends', async () => {
    const hubToRuntime = new PassThrough();
    const runtimeToHub = new PassThrough();

    const host = new RuntimeHost({
      runtimeVersion: 'runtime-test',
      manifest,
      handlers: new Map([
        [
          'snapshot.hash',
          async (params) => ({ hash: `hash:${(params as { path: string }).path}` }),
        ],
      ]),
    });
    host.attach(createStdioFramePort({ input: hubToRuntime, output: runtimeToHub }));

    const client = new RuntimeProtocolClient(
      createStdioFramePort({ input: runtimeToHub, output: hubToRuntime }),
      { hubVersion: 'hub-test' }
    );
    host.start();

    try {
      await client.waitUntilReady();
      expect(client.runtimeVersion).toBe('runtime-test');
      expect(client.manifest).toEqual(manifest);
      await expect(client.request('snapshot.hash', { path: '/w/file.txt' })).resolves.toEqual({
        hash: 'hash:/w/file.txt',
      });
    } finally {
      client.close();
      host.close();
    }
  });
});
