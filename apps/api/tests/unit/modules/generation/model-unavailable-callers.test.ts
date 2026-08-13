/**
 * Every route that can reach a provider answers the deprecation the same way.
 *
 * The guard itself lives in `resolveModel`, so a caller cannot miss it by
 * accident — but a caller *can* catch `NoModelAvailableError` and answer with a
 * sentence, dropping the reason and the action on the floor. That is the failure
 * this pins: the refusal is only useful if it arrives at the client intact, and
 * it arrives through eight independent catch blocks.
 *
 * Read from source rather than driven over HTTP on purpose. Standing eight
 * route harnesses up would assert the same one-line mapping eight times at a
 * hundred times the cost, and would still not notice the ninth caller someone
 * adds next month — which is what the exhaustiveness check at the end is for.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API_SRC = join(import.meta.dir, '../../../../src');

/** Every `.ts` under `src`, so a new caller cannot hide in a new directory. */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listSourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const SOURCES = listSourceFiles(API_SRC).map((path) => ({
  path: path.slice(API_SRC.length + 1),
  text: readFileSync(path, 'utf8'),
}));

/** Files that turn a `NoModelAvailableError` into an HTTP response. */
const HTTP_CATCHERS = SOURCES.filter(
  (file) => file.path.includes('/http/') && file.text.includes('instanceof NoModelAvailableError')
);

describe('model-unavailable refusals reaching HTTP', () => {
  test('covers every enumerated caller', () => {
    expect(HTTP_CATCHERS.map((file) => file.path).sort()).toEqual([
      'modules/chats/http/chat-routes.ts',
      'modules/generation/http/capability-routes.ts',
      'modules/generation/http/generate-routes.ts',
      'modules/generation/http/respond-routes.ts',
      'modules/generation/http/respond-stream-routes.ts',
      'modules/git/http/git-routes.ts',
    ]);
  });

  test('every one answers through the shared mapper', () => {
    for (const file of HTTP_CATCHERS) {
      expect(file.text).toContain('modelUnavailableResponse');
    }
  });

  test('none of them hand-rolls a status or a code for it', () => {
    for (const file of HTTP_CATCHERS) {
      // The block between `instanceof NoModelAvailableError` and its closing
      // brace must delegate. A hand-written `set.status = 503` there is a
      // refusal that reaches the client without its details.
      for (const block of catchBlocksFor(file.text)) {
        expect(block).toContain('modelUnavailableResponse');
        expect(block).not.toContain('ERROR_CODES.PROVIDER_ERROR');
      }
    }
  });
});

/** The body of each `if (… instanceof NoModelAvailableError) { … }`. */
function catchBlocksFor(text: string): string[] {
  const blocks: string[] = [];
  let index = text.indexOf('instanceof NoModelAvailableError');
  while (index !== -1) {
    const open = text.indexOf('{', index);
    const close = text.indexOf('}', open);
    if (open !== -1 && close !== -1) blocks.push(text.slice(open, close));
    index = text.indexOf('instanceof NoModelAvailableError', index + 1);
  }
  return blocks;
}

describe('application-layer callers', () => {
  test('resolve their model through resolveModel, so the guard cannot be bypassed', () => {
    // Anything that resolves a provider for a stored model id has to go through
    // `resolveModel` or `getProviderForModel`; the first carries the guard and
    // the second is only ever reached with an id `resolveModel` already cleared.
    const providerResolvers = SOURCES.filter(
      (file) =>
        !file.path.startsWith('services/providers/') &&
        file.text.includes('getProviderForModel(') &&
        !file.path.includes('/http/')
    );

    for (const file of providerResolvers) {
      expect(`${file.path}: ${file.text.includes('resolveModel')}`).toBe(`${file.path}: true`);
    }
  });
});
