import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { forceKill, forceKillGroup, readWorkerPids, WORKERS_LOG } from './support/process-tree';
import {
  assertSignalablePid,
  parsePidText,
  readPidFile,
  signalPid,
  signalPidGroup,
  writePidFileAtomically,
} from './support/signal-pid';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mangostudio-signal-pid-'));
  dirs.push(dir);
  return dir;
}

describe('assertSignalablePid', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [-1, '-1'],
    [Number.NaN, 'NaN'],
    [1.5, '1.5'],
    ['4242', '"4242"'],
    ['', '""'],
    [undefined, 'undefined'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('refuses %p', (value, shown) => {
    expect(() => assertSignalablePid(value)).toThrow(`expected pid > 1 | received: ${shown}`);
  });

  it('returns an integer above 1 unchanged', () => {
    expect(assertSignalablePid(2)).toBe(2);
    expect(assertSignalablePid(4_194_304)).toBe(4_194_304);
  });
});

describe('parsePidText', () => {
  it('reads decimal digits and ignores surrounding whitespace', () => {
    expect(parsePidText('4242\n')).toBe(4242);
  });

  it.each(['', '  ', '0', '1', '-5', 'abc', '12ab', '1.5', '99999999999999999999'])(
    'refuses %p with the raw text in the message',
    (raw) => {
      expect(() => parsePidText(raw)).toThrow(
        `expected pid > 1 | received: ${JSON.stringify(raw)}`
      );
    }
  );
});

describe('readPidFile', () => {
  it('fails on an empty file instead of returning 0', () => {
    const file = join(scratchDir(), 'worker-1.pid');
    writeFileSync(file, '');

    expect(() => readPidFile(file)).toThrow(`pid file ${file}: expected pid > 1 | received: ""`);
  });

  it('reads a whole pid file', () => {
    const file = join(scratchDir(), 'worker-1.pid');
    writeFileSync(file, '777');

    expect(readPidFile(file)).toBe(777);
  });
});

describe('signalling helpers', () => {
  it.each([0, 1, -1, Number.NaN])('signalPid never reaches process.kill with %p', (pid) => {
    expect(() => signalPid(pid, 'SIGKILL')).toThrow('expected pid > 1');
    expect(() => signalPidGroup(pid, 'SIGKILL')).toThrow('expected pid > 1');
    expect(() => forceKill(pid)).toThrow('expected pid > 1');
    expect(() => forceKillGroup(pid)).toThrow('expected pid > 1');
  });

  it('signals a live process', () => {
    expect(() => signalPid(process.pid, 0)).not.toThrow();
  });
});

describe('readWorkerPids', () => {
  it('ignores a line that is still being written', () => {
    const dir = scratchDir();
    writeFileSync(join(dir, WORKERS_LOG), '1 start 4242\n2 start 43');

    expect(readWorkerPids(dir)).toEqual([4242]);
  });

  it('fails on a completed line with no pid instead of returning 0', () => {
    const dir = scratchDir();
    writeFileSync(join(dir, WORKERS_LOG), '1 start \n');

    expect(() => readWorkerPids(dir)).toThrow('expected pid > 1 | received: ""');
  });
});

describe('writePidFileAtomically', () => {
  it('leaves the pid file whole and no staging file behind', () => {
    const dir = scratchDir();
    const file = join(dir, 'worker-1.pid');

    writePidFileAtomically(file, 4242);

    expect(readPidFile(file)).toBe(4242);
    expect(readdirSync(dir)).toEqual(['worker-1.pid']);
  });

  it('refuses a pid that cannot be signalled and writes nothing', () => {
    const dir = scratchDir();
    const file = join(dir, 'worker-1.pid');

    expect(() => writePidFileAtomically(file, 0)).toThrow('expected pid > 1 | received: 0');
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is never seen empty by a reader polling while a writer publishes many files', async () => {
    const dir = scratchDir();
    const count = 400;
    const writer = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `const { writePidFileAtomically } = require(${JSON.stringify(join(import.meta.dir, 'support/signal-pid.ts'))}); for (let i = 0; i < ${count}; i++) writePidFileAtomically(process.argv[1] + '/f' + i + '.pid', 4242);`,
        dir,
      ],
      stdout: 'ignore',
      stderr: 'inherit',
    });
    const seenEmpty: string[] = [];
    for (let index = 0; index < count;) {
      const file = join(dir, `f${index}.pid`);
      if (!existsSync(file)) {
        await Promise.resolve();
        continue;
      }
      try {
        readPidFile(file);
      } catch (error) {
        seenEmpty.push((error as Error).message);
      }
      index += 1;
    }
    expect(await writer.exited).toBe(0);
    expect(seenEmpty, 'expected pid files read empty: 0').toEqual([]);
  });
});
