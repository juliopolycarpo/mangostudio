import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type BareErrorStatus, findBareErrorStatuses } from '../lib/api-bare-status-guard';
import { ROOT_DIR as REPO_ROOT } from '../lib/config';

const API_SRC = join(REPO_ROOT, 'apps/api/src');

function scanSource(source: string): BareErrorStatus[] {
  return findBareErrorStatuses(source, 'apps/api/src/modules/x/http/x-routes.ts');
}

function readApiSources(): Array<{ file: string; source: string }> {
  return readdirSync(API_SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => ({
      file: relative(REPO_ROOT, path).replaceAll('\\', '/'),
      source: readFileSync(path, 'utf8'),
    }));
}

describe('API bare error status guard', () => {
  const files = readApiSources();
  const offenders = files.flatMap(({ file, source }) => findBareErrorStatuses(source, file));

  it('keeps every API route on status(code, body)', () => {
    // Guards against scanning an empty tree and passing for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(({ file }) => file)).toContain('apps/api/src/routes/upload.ts');

    const found = offenders.map(
      ({ file, line, assigned }) => `${file}:${line} (set.status = ${assigned})`
    );
    expect(
      found,
      `expected no \`set.status = 4xx/5xx\` in apps/api/src; found: ${found.join(', ')}. ` +
        'A bare status types the error body into Eden `data`. Return `status(code, body)` ' +
        '(`apiErrorStatus` when the code is a runtime union) and declare the code in `response`.'
    ).toEqual([]);
  });

  it('flags a literal error status with its line', () => {
    const hits = scanSource(`
      app.get('/', ({ set }) => {
        set.status = 404;
        return { error: 'x' };
      });
    `);
    expect(hits).toEqual([
      { file: 'apps/api/src/modules/x/http/x-routes.ts', line: 3, assigned: '404' },
    ]);
  });

  it('flags context.set.status, a dynamic status and a single-statement if', () => {
    const hits = scanSource(`
      context.set.status = 405;
      set.status = refusal.status;
      if (!ok) set.status = 409;
      set.status = (500 as const);
    `);
    expect(hits.map(({ assigned }) => assigned)).toEqual(['405', 'refusal.status', '409', '500']);
  });

  it('accepts success and redirect codes', () => {
    expect(
      scanSource(`
        set.status = 201;
        set.status = 202;
        set.status = 204;
        set.status = 304;
      `)
    ).toEqual([]);
  });

  it('ignores status(code, body), reads and unrelated .status assignments', () => {
    expect(
      scanSource(`
        return status(404, { error: 'x' });
        const code = set.status;
        entry.status = 'failed';
        session.status = 500;
        set.headers.status = 500;
        if (set.status === 404) log();
      `)
    ).toEqual([]);
  });
});
