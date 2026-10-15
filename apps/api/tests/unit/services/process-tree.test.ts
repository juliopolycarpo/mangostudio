import { describe, expect, it } from 'bun:test';
import {
  descendantsOf,
  type ProcessEntry,
  parentPidFromStat,
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
  it.skipIf(process.platform !== 'linux')('includes this process under its parent', () => {
    const self = readProcessSnapshot().find((entry) => entry.pid === process.pid);
    expect(self?.parentPid).toBe(process.ppid);
  });
});
