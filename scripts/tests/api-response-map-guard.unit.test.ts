import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  collectConstAssertedObjectNames,
  type ConstResponseSpread,
  findConstResponseSpreads,
} from '../lib/api-response-map-guard';
import { ROOT_DIR as REPO_ROOT } from '../lib/config';

const API_SRC = join(REPO_ROOT, 'apps/api/src');

function scan(files: ReadonlyArray<{ file: string; source: string }>): ConstResponseSpread[] {
  const names = new Set(
    files.flatMap(({ file, source }) => collectConstAssertedObjectNames(source, file))
  );
  return files.flatMap(({ file, source }) => findConstResponseSpreads(source, file, names));
}

function scanOne(source: string): ConstResponseSpread[] {
  return scan([{ file: 'apps/api/src/modules/x/http/x-routes.ts', source }]);
}

describe('API response map guard', () => {
  it('keeps every route module free of spread `as const` error maps', () => {
    const files = readdirSync(API_SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      .map((path) => ({
        file: relative(REPO_ROOT, path).replaceAll('\\', '/'),
        source: readFileSync(path, 'utf8'),
      }));
    // Guards against scanning an empty tree and passing for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(({ file }) => file)).toContain(
      'apps/api/src/modules/api-keys/http/api-key-routes.ts'
    );

    const offenders = scan(files).map(({ file, line, spread }) => `${file}:${line} (...${spread})`);
    expect(
      offenders,
      `expected no \`as const\` map spread into a route \`response\`; found: ${offenders.join(', ')}. ` +
        'Eden types such a route error channel as unknown. Drop `as const` from the map.'
    ).toEqual([]);
  });

  it('flags a named as-const map spread into response', () => {
    const hits = scanOne(`
      const errorResponses = { 401: Schema, 500: Schema } as const;
      app.get('/', { response: { 200: Ok, ...errorResponses } }, () => ok);
    `);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 3, spread: 'errorResponses' });
  });

  it('flags the map through satisfies and parentheses', () => {
    const hits = scanOne(`
      const errorResponses = ({ 401: Schema } as const) satisfies Record<number, unknown>;
      const other = { 500: Schema } as const satisfies Record<number, unknown>;
      app.get('/', { response: { ...errorResponses, ...other } }, () => ok);
    `);
    expect(hits.map(({ spread }) => spread)).toEqual(['errorResponses', 'other']);
  });

  it('flags a map declared in one file and spread in another', () => {
    const hits = scan([
      {
        file: 'apps/api/src/shared-errors.ts',
        source: 'export const sharedErrors = { 401: Schema } as const;',
      },
      {
        file: 'apps/api/src/modules/y/http/y-routes.ts',
        source: "app.get('/', { response: { 200: Ok, ...sharedErrors } }, () => ok);",
      },
    ]);
    expect(hits).toEqual([
      { file: 'apps/api/src/modules/y/http/y-routes.ts', line: 1, spread: 'sharedErrors' },
    ]);
  });

  it('flags an inline as-const spread', () => {
    const hits = scanOne(
      "app.get('/', { response: { ...({ 401: Schema } as const) } }, () => ok);"
    );
    expect(hits).toHaveLength(1);
  });

  it('accepts a plain map, a non-response spread, and a non-object as-const', () => {
    const hits = scanOne(`
      const errorResponses = { 401: Schema, 500: Schema };
      const statuses = [401, 500] as const;
      const headers = { a: 1 } as const;
      app.get('/', { response: { 200: Ok, ...errorResponses }, detail: { ...headers } }, () => ok);
      const copy = { ...headers };
    `);
    expect(hits).toEqual([]);
  });
});
