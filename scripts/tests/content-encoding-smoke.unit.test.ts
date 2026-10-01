import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import {
  collectContentEncodingProblems,
  collectPathProblems,
  fetchRaw,
} from '../lib/content-encoding-smoke';

const SCRIPT = Buffer.from(`export const greeting = ${JSON.stringify('hello '.repeat(400))};\n`);
const STYLE = Buffer.from(`.greeting { content: ${JSON.stringify('hello '.repeat(400))}; }\n`);
const SHELL = Buffer.from(
  '<!doctype html><html><body><link rel="stylesheet" href="/assets/app-1.css" />' +
    '<script type="module" src="/assets/app-1.js"></script></body></html>'
);
const BODIES: Record<string, Buffer> = {
  '/': SHELL,
  '/assets/app-1.js': SCRIPT,
  '/assets/app-1.css': STYLE,
};
const CONTENT_TYPES: Record<string, string> = {
  '/': 'text/html',
  '/assets/app-1.js': 'text/javascript;charset=utf-8',
  '/assets/app-1.css': 'text/css',
};

/** What the fake hub gets wrong. Every field is a defect a compiled binary could ship. */
interface Defects {
  /** Always answer identity, as a binary that lost its precompressed copies would. */
  neverCompress?: boolean;
  /** Answer a gzip request with a Brotli stream under a gzip header, and the reverse. */
  swapCodings?: boolean;
  /** Corrupt one byte inside the Brotli representation. */
  corruptBrotli?: boolean;
  omitVary?: boolean;
  /** Stream the body chunked, with no Content-Length. */
  omitLength?: boolean;
  /** Answer a request that refuses every coding with 406. */
  refuseWith406?: boolean;
  /** Send the same ETag for every representation. */
  sharedEtag?: boolean;
  /** Serve a shell that names no hashed asset. */
  bareShell?: boolean;
}

interface FakeHub {
  baseUrl: string;
  /** The Accept-Encoding header of every request, in arrival order. */
  acceptEncodings: string[];
  stop(): Promise<void>;
}

const running: FakeHub[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((hub) => hub.stop()));
});

function representation(
  path: string,
  coding: 'gzip' | 'br' | null,
  defects: Defects
): { body: Buffer; encoding: string | null } {
  const identity = defects.bareShell && path === '/' ? Buffer.from('<html></html>') : BODIES[path];
  if (!identity) throw new Error(`fake hub has no body for ${path}`);
  if (!coding) return { body: identity, encoding: null };
  const effective = defects.swapCodings ? (coding === 'gzip' ? 'br' : 'gzip') : coding;
  const body = effective === 'gzip' ? gzipSync(identity) : brotliCompressSync(identity);
  if (defects.corruptBrotli && coding === 'br') body[body.length >> 1] ^= 0xff;
  return { body, encoding: coding };
}

function chooseCoding(header: string): 'gzip' | 'br' | null {
  if (header.includes('br')) return 'br';
  if (header.includes('gzip')) return 'gzip';
  return null;
}

function answer(req: IncomingMessage, res: ServerResponse, defects: Defects, log: string[]): void {
  const path = req.url ?? '';
  const header = String(req.headers['accept-encoding'] ?? '');
  log.push(header);
  if (!(path in BODIES)) {
    res.writeHead(404).end();
    return;
  }
  if (defects.refuseWith406 && header.includes('q=0')) {
    res.writeHead(406).end();
    return;
  }
  const coding = defects.neverCompress ? null : chooseCoding(header);
  const { body, encoding } = representation(path, coding, defects);
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPES[path] as string,
    ETag: defects.sharedEtag ? '"same"' : `"${path}-${encoding ?? 'identity'}-${body.length}"`,
  };
  if (!defects.omitLength) headers['Content-Length'] = String(body.length);
  if (!defects.omitVary) headers.Vary = 'Origin, Accept-Encoding';
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  res.end(body);
}

/** A hub that negotiates by `Accept-Encoding` over fixed bodies, with the given defects. */
async function startFakeHub(defects: Defects = {}): Promise<FakeHub> {
  const acceptEncodings: string[] = [];
  const server: Server = createServer((req, res) => answer(req, res, defects, acceptEncodings));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const hub: FakeHub = {
    baseUrl: `http://127.0.0.1:${port}`,
    acceptEncodings,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  running.push(hub);
  return hub;
}

describe('fetchRaw', () => {
  test('hands back the encoded bytes and the exact Accept-Encoding it was given', async () => {
    const hub = await startFakeHub();
    const response = await fetchRaw(`${hub.baseUrl}/assets/app-1.js`, 'gzip');

    expect(
      { encoding: response.headers['content-encoding'], bytes: response.body.length },
      'a client that decodes would report the identity size'
    ).toEqual({ encoding: 'gzip', bytes: gzipSync(SCRIPT).length });
    expect(response.body.subarray(0, 2), 'gzip magic number').toEqual(Buffer.from([0x1f, 0x8b]));
    expect(hub.acceptEncodings).toEqual(['gzip']);
  });

  test('sends a refusal verbatim', async () => {
    const hub = await startFakeHub();
    await fetchRaw(`${hub.baseUrl}/`, 'identity;q=0');
    expect(hub.acceptEncodings).toEqual(['identity;q=0']);
  });
});

describe('collectContentEncodingProblems', () => {
  test('reports nothing for a hub that negotiates correctly, and names what it checked', async () => {
    const hub = await startFakeHub();
    const { paths, problems } = await collectContentEncodingProblems(hub.baseUrl);

    expect(problems).toEqual([]);
    expect(paths).toEqual(['/', '/assets/app-1.js', '/assets/app-1.css']);
  });

  test('flags a hub that stopped serving compressed assets', async () => {
    const hub = await startFakeHub({ neverCompress: true });
    const { problems } = await collectContentEncodingProblems(hub.baseUrl);

    expect(problems).toContain(
      '/assets/app-1.js [Accept-Encoding: gzip] Content-Encoding: expected gzip | received (none)'
    );
    expect(problems).toContain(
      '/assets/app-1.js [Accept-Encoding: br] Content-Encoding: expected br | received (none)'
    );
  });

  test('flags a corrupt Brotli variant even though its headers are right', async () => {
    const hub = await startFakeHub({ corruptBrotli: true });
    const problems = await collectPathProblems(hub.baseUrl, '/assets/app-1.js');

    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(
      '/assets/app-1.js [Accept-Encoding: br] body: expected a valid br stream'
    );
  });

  test('flags a coding served under the wrong Content-Encoding', async () => {
    const hub = await startFakeHub({ swapCodings: true });
    const problems = await collectPathProblems(hub.baseUrl, '/assets/app-1.css');

    expect(problems.join('\n')).toContain(
      '/assets/app-1.css [Accept-Encoding: gzip] body: expected a valid gzip stream'
    );
  });

  test('flags a missing Vary: Accept-Encoding', async () => {
    const hub = await startFakeHub({ omitVary: true });
    const problems = await collectPathProblems(hub.baseUrl, '/');

    expect(problems).toContain(
      '/ [identity] Vary: expected a list containing Accept-Encoding | received (none)'
    );
  });

  test('flags a representation that declares no Content-Length', async () => {
    const hub = await startFakeHub({ omitLength: true });
    const problems = await collectPathProblems(hub.baseUrl, '/assets/app-1.js');

    expect(problems).toContain(
      `/assets/app-1.js [Accept-Encoding: gzip] Content-Length: expected ${gzipSync(SCRIPT).length} (bytes received) | received (none)`
    );
  });

  test('flags a refusal of every coding that is not answered with 200 identity', async () => {
    const hub = await startFakeHub({ refuseWith406: true });
    const problems = await collectPathProblems(hub.baseUrl, '/assets/app-1.js');

    expect(problems).toContain(
      '/assets/app-1.js [Accept-Encoding: identity;q=0] status: expected 200 | received 406'
    );
  });

  test('flags representations that share a validator', async () => {
    const hub = await startFakeHub({ sharedEtag: true });
    const problems = await collectPathProblems(hub.baseUrl, '/assets/app-1.js');

    expect(problems).toContain(
      '/assets/app-1.js [Accept-Encoding: gzip] ETag: expected one distinct from the identity ETag | received the same, "same"'
    );
  });

  test('flags a shell that references no hashed asset instead of silently checking less', async () => {
    const hub = await startFakeHub({ bareShell: true });
    const { paths, problems } = await collectContentEncodingProblems(hub.baseUrl);

    expect(paths).toEqual(['/']);
    expect(problems).toContain('/ shell: expected a /assets/*.js reference | received none');
    expect(problems).toContain('/ shell: expected a /assets/*.css reference | received none');
  });
});
