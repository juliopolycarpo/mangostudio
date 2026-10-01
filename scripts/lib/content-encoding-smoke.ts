/**
 * Content-encoding assertions for the compiled hub, used by `scripts/test-build.ts`.
 *
 * The embedded frontend is served from precompressed gzip and Brotli copies chosen by
 * `Accept-Encoding`. `fetch` negotiates and decodes transparently, so a smoke written with it
 * keeps passing when the binary stops serving compressed bytes or serves a corrupt copy. The
 * client here is `node:http`, which never decodes: what it returns is what the wire carried.
 *
 * Dependency-free on purpose (Node builtins only): the smoke job runs `bun --no-install`.
 */

import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

/** One response with its body exactly as received: still encoded when the server encoded it. */
export interface RawResponse {
  status: number;
  /** Lower-cased names; repeated headers are joined with `, `. */
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}

type Coding = 'gzip' | 'br';

const REQUEST_TIMEOUT_MS = 10_000;
const NONE = '(none)';

/**
 * GET `url` sending exactly `acceptEncoding` and decode nothing.
 *
 * @example
 * const { headers, body } = await fetchRaw('http://127.0.0.1:3001/', 'gzip');
 * // headers['content-encoding'] === 'gzip'; body is the gzip stream
 */
export function fetchRaw(url: string, acceptEncoding: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { agent: false, headers: { 'Accept-Encoding': acceptEncoding }, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              headers[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(
        new Error(
          `GET ${url} (Accept-Encoding: ${acceptEncoding}) | expected a response within ${REQUEST_TIMEOUT_MS}ms | received none`
        )
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** Where two buffers first differ, for a message that says more than "not equal". */
function describeDifference(expected: Buffer, received: Buffer): string {
  const shared = Math.min(expected.length, received.length);
  let offset = 0;
  while (offset < shared && expected[offset] === received[offset]) offset += 1;
  return `expected ${expected.length} bytes | received ${received.length} bytes, first difference at byte ${offset}`;
}

function decode(coding: Coding, body: Buffer): Buffer | string {
  try {
    return coding === 'gzip' ? gunzipSync(body) : brotliDecompressSync(body);
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

function varyNamesAcceptEncoding(vary: string | undefined): boolean {
  return (vary ?? '')
    .split(',')
    .some((member) => member.trim().toLowerCase() === 'accept-encoding');
}

/**
 * Everything one response must satisfy regardless of the coding it carries.
 * `expectedCoding` is `null` for identity.
 */
function checkRepresentation(
  label: string,
  response: RawResponse,
  expectedCoding: Coding | null
): string[] {
  const problems: string[] = [];
  const { status, headers, body } = response;
  if (status !== 200) problems.push(`${label} status: expected 200 | received ${status}`);

  const encoding = headers['content-encoding'];
  const expectedEncoding = expectedCoding ?? NONE;
  if ((encoding ?? NONE) !== expectedEncoding) {
    problems.push(
      `${label} Content-Encoding: expected ${expectedEncoding} | received ${encoding ?? NONE}`
    );
  }
  if (!varyNamesAcceptEncoding(headers.vary)) {
    problems.push(
      `${label} Vary: expected a list containing Accept-Encoding | received ${headers.vary ?? NONE}`
    );
  }
  if (headers['content-length'] !== String(body.length)) {
    problems.push(
      `${label} Content-Length: expected ${body.length} (bytes received) | received ${headers['content-length'] ?? NONE}`
    );
  }
  const etag = headers.etag;
  if (!etag || etag.startsWith('W/')) {
    problems.push(`${label} ETag: expected a strong validator | received ${etag ?? NONE}`);
  }
  if (!headers['content-type']) {
    problems.push(`${label} Content-Type: expected a media type | received ${NONE}`);
  }
  return problems;
}

/** The checks that need the identity body to compare against. */
function checkAgainstIdentity(
  label: string,
  response: RawResponse,
  identity: RawResponse,
  coding: Coding | null
): string[] {
  const problems: string[] = [];
  const identityType = identity.headers['content-type'];
  if (identityType && response.headers['content-type'] !== identityType) {
    problems.push(
      `${label} Content-Type: expected ${identityType} (the identity type) | received ${response.headers['content-type'] ?? NONE}`
    );
  }
  if (!coding) {
    if (!response.body.equals(identity.body)) {
      problems.push(`${label} body: ${describeDifference(identity.body, response.body)}`);
    }
    return problems;
  }
  if (response.headers.etag && response.headers.etag === identity.headers.etag) {
    problems.push(
      `${label} ETag: expected one distinct from the identity ETag | received the same, ${response.headers.etag}`
    );
  }
  if (response.body.length >= identity.body.length) {
    problems.push(
      `${label} body: expected fewer than ${identity.body.length} bytes (the identity size) | received ${response.body.length}`
    );
  }
  const decoded = decode(coding, response.body);
  if (typeof decoded === 'string') {
    problems.push(`${label} body: expected a valid ${coding} stream | received ${decoded}`);
  } else if (!decoded.equals(identity.body)) {
    problems.push(
      `${label} decoded body differs from the identity body: ${describeDifference(identity.body, decoded)}`
    );
  }
  return problems;
}

/**
 * The gzip and Brotli copies are different bytes, so they need different validators: a shared one
 * lets a conditional request for one coding answer 304 from the other's validator.
 */
function checkCompressedValidatorsDiffer(
  path: string,
  compressed: ReadonlyMap<Coding, RawResponse>
): string[] {
  const gzipEtag = compressed.get('gzip')?.headers.etag;
  const brotliEtag = compressed.get('br')?.headers.etag;
  if (!gzipEtag || gzipEtag !== brotliEtag) return [];
  return [
    `${path} [Accept-Encoding: br] ETag: expected one distinct from the gzip ETag | received the same, ${brotliEtag}`,
  ];
}

/** `Accept-Encoding` values sent per representation, in the order they are checked. */
const REPRESENTATIONS: ReadonlyArray<{ header: string; coding: Coding }> = [
  { header: 'gzip', coding: 'gzip' },
  { header: 'br', coding: 'br' },
];

/**
 * Checks one path over the wire: identity, gzip, Brotli, and a client that refuses every coding.
 *
 * @example
 * const problems = await collectPathProblems('http://127.0.0.1:3001', '/assets/main-abc.js');
 */
export async function collectPathProblems(baseUrl: string, path: string): Promise<string[]> {
  const url = `${baseUrl}${path}`;
  const identity = await fetchRaw(url, 'identity');
  const problems = checkRepresentation(`${path} [identity]`, identity, null);
  if (identity.status !== 200) return problems;

  const compressed = new Map<Coding, RawResponse>();
  for (const { header, coding } of REPRESENTATIONS) {
    const label = `${path} [Accept-Encoding: ${header}]`;
    const response = await fetchRaw(url, header);
    compressed.set(coding, response);
    problems.push(
      ...checkRepresentation(label, response, coding),
      ...checkAgainstIdentity(label, response, identity, coding)
    );
  }
  problems.push(...checkCompressedValidatorsDiffer(path, compressed));

  // Refusing every coding is not a 406: the server answers identity, as it did before copies.
  const refusedLabel = `${path} [Accept-Encoding: identity;q=0]`;
  const refused = await fetchRaw(url, 'identity;q=0');
  problems.push(
    ...checkRepresentation(refusedLabel, refused, null),
    ...checkAgainstIdentity(refusedLabel, refused, identity, null)
  );
  return problems;
}

/** The first hashed script and stylesheet the shell references. */
function hashedAssetPaths(shell: string): { js: string | null; css: string | null } {
  const references = [...shell.matchAll(/(?:href|src)="(\/assets\/[^"]+\.(?:js|css))"/g)];
  const paths = references.map((match) => match[1] as string);
  return {
    js: paths.find((path) => path.endsWith('.js')) ?? null,
    css: paths.find((path) => path.endsWith('.css')) ?? null,
  };
}

/**
 * Asserts content negotiation for the shell and one hashed script and stylesheet of a running hub.
 * The asset paths come from the shell the hub serves, so they are the ones this build embeds.
 *
 * @example
 * const { paths, problems } = await collectContentEncodingProblems('http://127.0.0.1:3001');
 * if (problems.length > 0) throw new Error(problems.join('\n'));
 */
export async function collectContentEncodingProblems(
  baseUrl: string
): Promise<{ paths: string[]; problems: string[] }> {
  const shell = await fetchRaw(`${baseUrl}/`, 'identity');
  const { js, css } = hashedAssetPaths(shell.body.toString('utf8'));
  const problems: string[] = [];
  if (!js) problems.push('/ shell: expected a /assets/*.js reference | received none');
  if (!css) problems.push('/ shell: expected a /assets/*.css reference | received none');

  const paths = ['/', ...[js, css].filter((path): path is string => path !== null)];
  for (const path of paths) {
    problems.push(...(await collectPathProblems(baseUrl, path)));
  }
  return { paths, problems };
}
