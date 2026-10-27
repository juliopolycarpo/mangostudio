import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  descendantsOf,
  parentPidFromStat,
  type ProcessEntry,
  readProcessSnapshot,
  vendorProcessesOf,
} from '../../support/external-agents/process-tree';

const CODEX = '/home/ada/.codex/bin/codex';

/** The runtime (100), its helper (101), the codex it hosts (102), and the developer's own codex (900). */
const MACHINE: readonly ProcessEntry[] = [
  { pid: 1, parentPid: 0, executable: '/sbin/init' },
  { pid: 100, parentPid: 1, executable: '/target/mangostudio-runtime' },
  { pid: 101, parentPid: 100, executable: '/target/mangostudio-runtime' },
  { pid: 102, parentPid: 101, executable: CODEX },
  { pid: 103, parentPid: 102, executable: '/usr/bin/git' },
  { pid: 900, parentPid: 1, executable: CODEX },
];

describe('descendantsOf', () => {
  it('lists children and grandchildren, nearest first, without the root', () => {
    expect(descendantsOf(100, MACHINE)).toEqual([101, 102, 103]);
  });

  it('lists nothing for a pid that started no process', () => {
    expect(descendantsOf(103, MACHINE)).toEqual([]);
  });
});

describe('vendorProcessesOf', () => {
  it('finds the vendor the runtime started and leaves the developer’s own session alone', () => {
    expect(vendorProcessesOf(100, CODEX, MACHINE)).toEqual([102]);
  });

  it('finds nothing once the vendor process is gone', () => {
    const gone = MACHINE.filter((entry) => entry.pid !== 102);
    expect(vendorProcessesOf(100, CODEX, gone)).toEqual([]);
  });
});

describe('parentPidFromStat', () => {
  it('reads the parent after a command name that contains spaces and parentheses', () => {
    expect(parentPidFromStat('42 (codex (app) server) S 7 42 42 0 -1')).toBe(7);
  });

  it('names the line it could not read', () => {
    expect(() => parentPidFromStat('garbage')).toThrow(
      'expected a /proc stat line with a numeric parent pid | received: garbage'
    );
  });
});

describe('readProcessSnapshot', () => {
  it('reads proc-shaped fixtures on every host and skips vanished or malformed entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'mango-proc-fixture-'));
    try {
      for (const pid of ['7', '42', '43', '44', 'not-a-pid']) {
        mkdirSync(join(root, pid));
      }
      writeFileSync(join(root, '7/stat'), '7 (runtime) S 1 7 7 0 -1');
      writeFileSync(join(root, '42/stat'), '42 (codex (app) server) S 7 42 42 0 -1');
      writeFileSync(join(root, '43/stat'), 'malformed');
      writeFileSync(join(root, 'not-a-pid/stat'), '99 (ignored) S 7 99 99 0 -1');
      // Missing stat models a vanished process; missing exe remains optional.
      expect(readProcessSnapshot(root).sort((a, b) => a.pid - b.pid)).toEqual([
        { pid: 7, parentPid: 1 },
        { pid: 42, parentPid: 7 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')('includes this Linux process under its parent', () => {
    const self = readProcessSnapshot().find((entry) => entry.pid === process.pid);
    expect(self?.parentPid).toBe(process.ppid);
  });
});
