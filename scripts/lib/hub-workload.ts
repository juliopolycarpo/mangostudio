/**
 * A small, fixed request workload for a running hub: sign up and in, list chats, and fetch the
 * shell and its largest script as br, gzip and identity. The footprint benchmark measures memory
 * after it, and the AOT order recording runs it so the recorded function order covers what a hub
 * touches in its first minutes. Both need the same requests, so they share this file.
 */

import { fetchRaw } from './content-encoding-smoke';
import { summarizeLatencies } from './latency-stats';

const ASSET_REPEATS = 10;
const CHAT_LIST_REPEATS = 5;
const WORKLOAD_ENCODINGS = ['br', 'gzip', 'identity'] as const;
type WorkloadEncoding = (typeof WORKLOAD_ENCODINGS)[number];

export interface WorkloadResult {
  /** Median ms per request of the largest referenced script, by `Accept-Encoding`. */
  readonly assetMedianMs: Readonly<Record<WorkloadEncoding, number>>;
  readonly assetPath: string;
}

/**
 * The hashed `/assets/*.js` and `.css` URLs an index page references, in page order, without duplicates.
 * Example: referencedAssetPaths('<script src="/assets/main-1.js">') // ['/assets/main-1.js']
 */
export function referencedAssetPaths(indexHtml: string): string[] {
  const found = new Set<string>();
  for (const match of indexHtml.matchAll(/["'](\/assets\/[^"']+\.(?:js|css))["']/g)) {
    found.add(match[1] as string);
  }
  return [...found];
}

async function signedInCookie(baseUrl: string): Promise<string> {
  const email = `workload-${Date.now()}@test.local`;
  const password = 'workload-pass-12345';
  const headers = { 'Content-Type': 'application/json', Origin: baseUrl };
  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, name: 'Workload' }),
  });
  if (!signUp.ok) {
    throw new Error(`sign-up: expected 2xx | received ${signUp.status} ${await signUp.text()}`);
  }
  const signIn = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) {
    throw new Error(`sign-in: expected 2xx | received ${signIn.status} ${await signIn.text()}`);
  }
  return signIn.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/**
 * Runs the workload against `baseUrl` and returns how long the largest script took per encoding.
 * Example: await runHubWorkload('http://127.0.0.1:3001')
 */
export async function runHubWorkload(baseUrl: string): Promise<WorkloadResult> {
  const cookie = await signedInCookie(baseUrl);
  for (let index = 0; index < CHAT_LIST_REPEATS; index += 1) {
    const chats = await fetch(`${baseUrl}/api/chats/`, { headers: { Cookie: cookie } });
    if (!chats.ok) throw new Error(`GET /api/chats/: expected 2xx | received ${chats.status}`);
    await chats.arrayBuffer();
  }
  let indexHtml = '';
  for (const encoding of WORKLOAD_ENCODINGS) {
    const page = await fetchRaw(`${baseUrl}/`, encoding);
    if (page.status !== 200) {
      throw new Error(`GET / (${encoding}): expected 200 | received ${page.status}`);
    }
    if (encoding === 'identity') indexHtml = page.body.toString('utf8');
  }
  // Largest by identity size, found with one identity request each.
  let assetPath = '';
  let assetBytes = -1;
  for (const path of referencedAssetPaths(indexHtml).filter((p) => p.endsWith('.js'))) {
    const response = await fetchRaw(`${baseUrl}${path}`, 'identity');
    if (response.status === 200 && response.body.length > assetBytes) {
      assetPath = path;
      assetBytes = response.body.length;
    }
  }
  if (!assetPath) {
    throw new Error(
      `index page: expected a referenced /assets/*.js | received: ${indexHtml.slice(0, 200)}`
    );
  }
  const medians: Partial<Record<WorkloadEncoding, number>> = {};
  for (const encoding of WORKLOAD_ENCODINGS) {
    const samples: number[] = [];
    for (let index = 0; index < ASSET_REPEATS; index += 1) {
      const startedAt = performance.now();
      const response = await fetchRaw(`${baseUrl}${assetPath}`, encoding);
      samples.push(performance.now() - startedAt);
      if (response.status !== 200) {
        throw new Error(
          `GET ${assetPath} (${encoding}): expected 200 | received ${response.status}`
        );
      }
    }
    medians[encoding] = summarizeLatencies(samples).median;
  }
  return { assetMedianMs: medians as Record<WorkloadEncoding, number>, assetPath };
}
