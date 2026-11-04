import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { fixtureHomeEnv, homeEnv } from '../lib/temp-home';
import { testHomeEnv } from '../lib/test-home';

const directoryKeys = [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_DIRS',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

describe('temporary home environment', () => {
  it('keeps the benchmark home overrides limited to HOME and USERPROFILE', () => {
    const home = join(tmpdir(), 'benchmark-home');
    expect(homeEnv(home)).toEqual({ HOME: home, USERPROFILE: home });
  });

  it('confines inherited directory overrides in an actual child process', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'mango-home-env-'));
    const home = join(sandbox, 'home');
    const external = join(sandbox, 'external');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(external);
    const ambient = { ...process.env };
    for (const key of directoryKeys) ambient[key] = external;
    try {
      for (const overrides of [fixtureHomeEnv(home), testHomeEnv(home, ambient)]) {
        const child = Bun.spawn(
          [
            process.execPath,
            '-e',
            `
          const { mkdirSync, writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const { homedir } = require('node:os');
          const roots = Object.fromEntries(${JSON.stringify(directoryKeys)}.map(key => [key, process.env[key]]));
          for (const [key, root] of Object.entries(roots)) {
            mkdirSync(join(root, 'fixture'), { recursive: true });
            writeFileSync(join(root, 'fixture', key), 'private fixture state');
          }
          console.log(JSON.stringify({ roots, home: homedir() }));
        `,
          ],
          { env: { ...ambient, ...overrides }, stdout: 'pipe', stderr: 'pipe' }
        );
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exit, stderr).toBe(0);
        const report = JSON.parse(stdout);
        expect(report.home).toBe(home);
        for (const key of directoryKeys) {
          const path = relative(home, report.roots[key]);
          expect(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path), key).toBe(false);
        }
        expect(readdirSync(external)).toEqual([]);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
