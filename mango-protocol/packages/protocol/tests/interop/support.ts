/**
 * The harness the interop suites share: building the Rust peer, starting it,
 * and the behaviour every direction has to reproduce.
 *
 * These tests are the only ones in the repository that need both toolchains,
 * so they are off unless `MANGO_INTEROP=1` is set. `bun run test` sets it when
 * Cargo is present; the `interop` CI job sets it explicitly.
 */

import { expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import catalogExample from '../../../../spec/fixtures/1/catalog-example.json';
import { CLOSE_CODES } from '../../src/close';
import { CHUNK_HEADER_BYTES } from '../../src/codec/chunk';
import { assertCatalog } from '../../src/schemas/catalog';
import type { Session } from '../../src/session';
import { rejectionOf } from '../../src/testing/rejection';

/** Off unless the runner asked for it; these tests need Cargo. */
export const INTEROP_ENABLED = process.env.MANGO_INTEROP === '1';

/** Who the Rust peer says it is: the conformance suite's side `b`. */
export const PEER_NAME = 'conformance-b';

/** The credential the peer is started with, where a transport carries one. */
export const PEER_TOKEN = 'interop-token';

/** How long a peer has to announce its address before the test gives up. */
const START_TIMEOUT_MS = 60_000;

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/[\\/]$/, '');

/** The features the example needs; the same list the CI job builds with. */
const PEER_FEATURES = 'testing,websocket,spawn';

let built: Promise<string> | undefined;

/**
 * Builds `examples/conformance_peer` once per test run and answers with the
 * binary's path. Cargo itself is the cache; a second call is a no-op.
 *
 * @example
 * const binary = await peerBinary();
 */
export function peerBinary(): Promise<string> {
  built ??= build();
  return built;
}

async function build(): Promise<string> {
  const proc = Bun.spawn(
    [
      'cargo',
      'build',
      '--quiet',
      '--locked',
      '--example',
      'conformance_peer',
      '--features',
      PEER_FEATURES,
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`cargo build --example conformance_peer failed:\n${stderr}`);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return `${ROOT}/target/debug/examples/conformance_peer${suffix}`;
}

/** A peer process, and the address it announced. */
export interface RunningPeer {
  /** What the peer printed after `listening `: a path, or `host:port`. */
  readonly address: string;
  /** Everything it has said on stderr, for a failure message worth reading. */
  diagnostics(): string;
  /** Waits for the process to end and answers with its exit code. */
  readonly exited: Promise<number>;
  stop(): void;
}

/**
 * Starts the peer and waits for the `listening <address>` line it prints on
 * stderr once it is ready to be dialled.
 *
 * @example
 * const peer = await startPeer(['--ws', '127.0.0.1:0', '--token', PEER_TOKEN]);
 */
export async function startPeer(args: readonly string[]): Promise<RunningPeer> {
  const binary = await peerBinary();
  const proc = Bun.spawn([binary, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const lines: string[] = [];
  // Reading continues for the whole run, not just until the address is
  // announced. The peer writes a line per connection it serves, and a stderr
  // nobody drains fills up and then breaks under it — which is how this
  // harness first killed the very peer it was testing.
  const listening = collectDiagnostics(proc.stderr, lines);

  const address = await Promise.race([
    listening,
    proc.exited.then((code) => {
      throw new Error(`the peer exited with ${code} before listening:\n${lines.join('\n')}`);
    }),
    timeout(START_TIMEOUT_MS, () => `the peer never announced an address:\n${lines.join('\n')}`),
  ]);

  return {
    address,
    diagnostics: () => lines.join('\n'),
    exited: proc.exited,
    stop: () => proc.kill(),
  };
}

/**
 * Collects the peer's stderr for the whole run, and resolves with the address
 * of the first `listening ` line.
 */
function collectDiagnostics(stream: ReadableStream<Uint8Array>, into: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const line of parts) {
          into.push(line);
          if (line.startsWith('listening ')) resolve(line.slice('listening '.length).trim());
        }
      }
      reject(
        new Error(`the peer's stderr ended before it announced an address:\n${into.join('\n')}`)
      );
    })();
  });
}

function timeout(ms: number, message: () => string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const handle = setTimeout(() => reject(new Error(message())), ms);
    (handle as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Every case an interop direction has to pass, against a session already
 * connected to the Rust peer.
 *
 * The conformance suite itself cannot run here: it drives both sessions, and
 * one of these two lives in another process. This is the behaviour that can be
 * proven from one side alone.
 *
 * @example
 * await expectMangoPeerBehaviour(session);
 */
export async function expectMangoPeerBehaviour(session: Session): Promise<void> {
  const remote = await session.ready;
  expect(remote.peer.name).toBe(PEER_NAME);
  expect(remote.protocol.major).toBe(1);

  expect(await session.request('test.echo', { over: 'the wire' })).toEqual({ over: 'the wire' });

  const bulk = (await session.request(
    'test.bulk',
    { bytes: 512 * 1024 },
    { timeoutMs: 30_000 }
  )) as {
    blob: string;
  };
  expect(bulk.blob.length).toBe(512 * 1024);

  expect(await rejectionOf(session.request('test.absent', {}))).toMatchObject({
    code: 'METHOD_UNSUPPORTED',
  });

  expect(
    await rejectionOf(session.request('test.refuse', { code: 'DENIED', message: 'no' }))
  ).toMatchObject({ code: 'DENIED', details: { echoed: true } });

  // The peer publishes the shared example catalog, so both halves compare
  // what crossed the wire against the same file on disk rather than against
  // a copy of it. `assertCatalog` is this SDK's own check of the peer's
  // document, which is the half a cross-language test can really prove.
  const discovered = await session.request('rpc.discover', {});
  assertCatalog(discovered);
  expect(discovered).toEqual(catalogExample);

  const controller = new AbortController();
  const cancelled = rejectionOf(session.request('test.forever', {}, { signal: controller.signal }));
  // The request has to be on the wire before the cancel chases it.
  await Bun.sleep(50);
  controller.abort();
  expect(await cancelled).toMatchObject({ code: 'CANCELLED' });
}

/**
 * The chunk message a single-frame line becomes: the nine-byte header of
 * websocket.md, then the line's bytes.
 *
 * @example
 * socket.send(oneChunk('{"type":"ping"}'));
 */
export function oneChunk(line: string): Uint8Array {
  const payload = new TextEncoder().encode(line);
  const message = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(message.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 0);
  view.setUint32(5, 1);
  message.set(payload, CHUNK_HEADER_BYTES);
  return message;
}

/** What a peer that read an unreadable hello must answer with. */
export const LEGACY_HELLO_CLOSE_CODE = CLOSE_CODES.PROTOCOL_MISMATCH;
