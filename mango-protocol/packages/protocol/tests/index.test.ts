import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as protocol from '../src';

const SOURCE_DIR = fileURLToPath(new URL('../src', import.meta.url));

describe('package entry point', () => {
  it('re-exports the version, schema, codec, close, error, session and contract surface', () => {
    const exported = Object.keys(protocol);

    for (const name of [
      'PROTOCOL_VERSION',
      'negotiate',
      'CLOSE_CODES',
      'closeCodeForCodecError',
      'CodecError',
      'RemoteError',
      'RESERVED_ERROR_CODES',
      'FrameSchema',
      'isFrame',
      'assertFrame',
      'CatalogSchema',
      'isCatalog',
      'encodeLine',
      'decodeLine',
      'LineDecoder',
      'encodeChunks',
      'ChunkReassembler',
      'maxChunksFor',
      'Session',
      'defineContract',
    ]) {
      expect(exported).toContain(name);
    }
  });

  it('keeps the core browser-safe: nothing reachable from src/index.ts imports node:', async () => {
    const reachable = await reachableModules(`${SOURCE_DIR}/index.ts`);
    const offenders = reachable.filter((path) => nodeImport.test(sources.get(path) ?? ''));

    expect(reachable.length).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it('still recognises a node: import, so the guard above can fail', () => {
    expect(nodeImport.test("import { Buffer } from 'node:buffer';")).toBe(true);
    expect(nodeImport.test("import('node:fs')")).toBe(true);
  });
});

const nodeImport = /(?:from|import|require)\s*\(?\s*['"]node:/;
const sources = new Map<string, string>();
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** Every module under src reachable from `entry` through static imports. */
async function reachableModules(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const text = await Bun.file(path).text();
    sources.set(path, text);
    for (const { path: specifier } of transpiler.scanImports(text)) {
      if (!specifier.startsWith('.')) continue;
      queue.push(await resolveLocal(path, specifier));
    }
  }
  return [...seen];
}

async function resolveLocal(from: string, specifier: string): Promise<string> {
  const base = fileURLToPath(new URL(specifier, pathToFileURL(from)));
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${from}; expected a .ts module under src`);
}
