import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GrepPatternError, PathAccessError } from '@mangostudio/shared/runtime-contract';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';
import {
  type RustAndTypeScriptRuntimes,
  spawnRustAndTypeScriptRuntimes,
} from '../../support/rust-typescript-runtimes';

const binary = resolveRustRuntimeBinary();

describe.skipIf(!binary.available)('Rust filesystem search matches the TypeScript runtime', () => {
  let directory: string;
  let home: string;
  let previousHome: string | undefined;
  let runtimes: RustAndTypeScriptRuntimes | undefined;
  let rust: RuntimeClient;
  let typescript: RuntimeClient;

  beforeAll(async () => {
    previousHome = process.env.MANGO_HOME;
    home = await scratchMangoHome('search-compat');
    process.env.MANGO_HOME = home;
    directory = join(await realpath(home), 'fixtures');
    await mkdir(join(directory, 'nested'), { recursive: true });
    await mkdir(join(directory, '.hidden'));
    await mkdir(join(directory, '..', 'outside'));
    await writeFile(join(directory, 'a.txt'), 'foofoo\r\nFOO\n😀\n');
    await writeFile(join(directory, 'b.ts'), 'é １２ _ 1\nfoo\n');
    await writeFile(join(directory, 'nested', 'c.txt'), '\ufefffoo\nhit\nhit\n');
    await writeFile(join(directory, '.hidden', 'secret.txt'), 'foo\n');
    await writeFile(join(directory, '.hidden', '.secret.txt'), 'foo\n');
    await writeFile(join(directory, '.dot.txt'), 'foo\n');
    await writeFile(join(directory, 'binary.txt'), Buffer.from('foo\0'));
    await writeFile(join(directory, '..', 'outside', 'parent.txt'), 'foo\n');
    if (process.platform !== 'win32') await writeFile(join(directory, 'a*b.txt'), 'foo\n');
    runtimes = await spawnRustAndTypeScriptRuntimes(binary.path, 'search-compat');
    ({ rust, typescript } = runtimes);
  }, 30_000);

  afterAll(async () => {
    await runtimes?.close();
    if (previousHome === undefined) delete process.env.MANGO_HOME;
    else process.env.MANGO_HOME = previousHome;
    if (home) await cleanupMangoHome(home);
  });

  it('agrees on glob braces, recursive paths, explicit dots, and result caps', async () => {
    const mismatches = [];
    for (const pattern of [
      '*',
      '**/*',
      '*.txt',
      '**/*.txt',
      '*.{txt,ts}',
      'nested/**',
      '.hidden/*',
      '[ab].*',
      '**',
      './*.txt',
      '**/a.txt',
      'nested',
      'nested/',
      '!*.ts',
      '../outside/*.txt',
      'missing/*.txt',
      'a.txt/*',
      ...(process.platform === 'win32' ? [] : ['a\\*b.txt']),
      join(directory, '*.txt'),
    ]) {
      for (const [includeDotfiles, maxResults, absolute] of [
        [false, 100, false],
        [true, 100, false],
        [false, 1, false],
        [true, 1, false],
        [false, 100, true],
        [true, 100, true],
      ] as const) {
        const params = {
          pattern,
          cwd: directory,
          maxResults,
          includeDotfiles,
          absolute,
        };
        const actual = await rust.fs.glob(params);
        const expected = await typescript.fs.glob(params);
        if (
          JSON.stringify(actual.matches) !== JSON.stringify(expected.matches) ||
          actual.truncated !== expected.truncated
        )
          mismatches.push({ params, actual, expected });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees on per-component dot rules and parent or escaped grep filters', async () => {
    for (const glob of [
      '.hidden/*',
      '../outside/*.txt',
      './*.txt',
      'missing/*.txt',
      'a.txt/*',
      ...(process.platform === 'win32' ? [] : ['a\\*b.txt']),
    ]) {
      const params = {
        pattern: 'foo',
        inputPath: '.',
        resolvedPath: directory,
        glob,
        caseInsensitive: false,
        maxResults: 100,
        maxMatchesPerFile: 10,
        maxFileSizeBytes: 1024,
        includeDotfiles: false,
      };
      expect(await rust.fs.grep(params)).toEqual(await typescript.fs.grep(params));
    }
  });

  it('agrees on ECMAScript UTF-16, captures, lookbehind, boundaries, and file caps', async () => {
    for (const pattern of [
      'foo',
      '(?<word>foo)\\k<word>',
      '(?<=foo)foo',
      '^..$',
      '\\w+',
      '\\d+',
      '\\bfoo\\b',
      '^$',
      '^\ufefffoo',
    ]) {
      for (const maxMatchesPerFile of [1, 100]) {
        const params = {
          pattern,
          inputPath: '.',
          resolvedPath: directory,
          caseInsensitive: true,
          maxResults: 100,
          maxMatchesPerFile,
          maxFileSizeBytes: 1024,
          includeDotfiles: false,
        };
        expect(await rust.fs.grep(params)).toEqual(await typescript.fs.grep(params));
      }
    }
  });

  it('preserves typed pattern and inaccessible-root errors at the Hub boundary', async () => {
    for (const client of [rust, typescript]) {
      for (const pattern of ['(', 'a'.repeat(1001)]) {
        await expect(
          client.fs.grep({
            pattern,
            inputPath: '.',
            resolvedPath: directory,
            caseInsensitive: false,
            maxResults: 10,
            maxMatchesPerFile: 10,
            maxFileSizeBytes: 1024,
            includeDotfiles: false,
          })
        ).rejects.toBeInstanceOf(GrepPatternError);
      }
      await expect(
        client.fs.glob({
          pattern: '*',
          cwd: join(directory, 'missing'),
          maxResults: 10,
          includeDotfiles: false,
          absolute: false,
        })
      ).rejects.toBeInstanceOf(PathAccessError);
    }
  });
});
