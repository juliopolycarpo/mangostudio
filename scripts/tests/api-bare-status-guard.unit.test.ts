import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type BareErrorStatus, findBareErrorStatuses } from '../lib/api-bare-status-guard';
import { ROOT_DIR as REPO_ROOT } from '../lib/config';

const API_SRC = join(REPO_ROOT, 'apps/api/src');

/**
 * Modules whose in-flight conversion PRs still own their bare
 * `set.status = 4xx/5xx` sites (issue #1388, item 4). Delete a module's entry
 * in the PR that converts it. The test below fails on an entry with no
 * offender left, so a landed conversion cannot leave a stale exemption behind.
 */
const IN_FLIGHT_MODULES: Readonly<Record<string, string>> = {
  'external-agents': 'apps/api/src/modules/external-agents/',
  generation: 'apps/api/src/modules/generation/',
  chats: 'apps/api/src/modules/chats/',
  messages: 'apps/api/src/modules/messages/',
  'file-checkpoints': 'apps/api/src/modules/file-checkpoints/',
};

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
  const owningModule = (offender: BareErrorStatus): string | undefined =>
    Object.keys(IN_FLIGHT_MODULES).find((module) =>
      offender.file.startsWith(IN_FLIGHT_MODULES[module] ?? '\0')
    );

  it('keeps every route outside the in-flight modules on status(code, body)', () => {
    // Guards against scanning an empty tree and passing for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(({ file }) => file)).toContain('apps/api/src/routes/upload.ts');

    const unowned = offenders
      .filter((offender) => owningModule(offender) === undefined)
      .map(({ file, line, assigned }) => `${file}:${line} (set.status = ${assigned})`);
    expect(
      unowned,
      `expected no \`set.status = 4xx/5xx\` outside the in-flight modules; found: ${unowned.join(', ')}. ` +
        'A bare status types the error body into Eden `data`. Return `status(code, body)` ' +
        '(`apiErrorStatus` when the code is a runtime union) and declare the code in `response`.'
    ).toEqual([]);
  });

  it('lists only in-flight modules that still have a bare site', () => {
    const stale = Object.keys(IN_FLIGHT_MODULES).filter(
      (module) => !offenders.some((offender) => owningModule(offender) === module)
    );
    expect(
      stale,
      `expected every IN_FLIGHT_MODULES entry to own a bare \`set.status\` site; stale: ${stale.join(', ')}. ` +
        'Remove the entry now that its module is converted.'
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
