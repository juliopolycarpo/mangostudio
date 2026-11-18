import { describe, expect, it } from 'bun:test';

import {
  type ProcessStartTimeHost,
  REAL_START_TIME_HOST,
} from '../../../src/lib/process-start-time';
import { linuxStartTicks, readProcessStartToken } from '../../../src/lib/process-start-token';

const BOOT_ID = '3f2a9c10-1111-2222-3333-444455556666';

/** `/proc/<pid>/stat` with `startTicks` as field 22. */
function statWithStartTicks(startTicks: string, comm = 'bun'): string {
  const afterComm = Array.from({ length: 50 }, (_, index) => String(index + 3));
  afterComm[0] = 'S';
  afterComm[19] = startTicks;
  return `42 (${comm}) ${afterComm.join(' ')}`;
}

/** Canned platform output. The macOS shape matches real `ps` output captured on a macOS runner (`Tue Nov 17 08:15:39 2026`, whole-second resolution, so a parent and child started in the same second share a token); the Windows shape is synthetic and the native run exercises the real reader. */
class FakeTokenHost implements ProcessStartTimeHost {
  readonly commands: string[][] = [];
  readonly envs: Array<Readonly<Record<string, string>> | undefined> = [];
  readonly creationTimeQueries: number[] = [];
  constructor(
    readonly platform: NodeJS.Platform,
    private readonly files: Record<string, string> = {},
    private readonly output: string | undefined | Error = undefined,
    private readonly creationTime: bigint | undefined | Error = undefined
  ) {}
  now = () => 0;
  readWindowsCreationTime = (pid: number): Promise<bigint | undefined> => {
    this.creationTimeQueries.push(pid);
    return this.creationTime instanceof Error
      ? Promise.reject(this.creationTime)
      : Promise.resolve(this.creationTime);
  };
  readText = (path: string): Promise<string> => {
    const text = this.files[path];
    return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
  };
  run = (
    command: readonly string[],
    env?: Readonly<Record<string, string>>
  ): Promise<string | undefined> => {
    this.commands.push([...command]);
    this.envs.push(env);
    return this.output instanceof Error
      ? Promise.reject(this.output)
      : Promise.resolve(this.output);
  };
}

describe('linuxStartTicks', () => {
  it('reads field 22', () => {
    expect(linuxStartTicks(statWithStartTicks('123456'))).toBe('123456');
  });

  it.each(['a) (b c', ') (', 'x y', '(((', 'a)b'])(
    'is not confused by comm %p holding spaces and parentheses',
    (comm) => {
      expect(linuxStartTicks(statWithStartTicks('777', comm))).toBe('777');
    }
  );

  it.each(['', 'garbage', '42 (x) S', statWithStartTicks('abc'), statWithStartTicks('')])(
    'is undefined for %p',
    (stat) => {
      expect(linuxStartTicks(stat)).toBeUndefined();
    }
  );
});

describe('readProcessStartToken', () => {
  it('joins boot_id and the start ticks on Linux, with no spawn', async () => {
    const host = new FakeTokenHost('linux', {
      '/proc/42/stat': statWithStartTicks('30000', 'a) (b'),
      '/proc/sys/kernel/random/boot_id': `${BOOT_ID}\n`,
    });

    expect(await readProcessStartToken(42, host)).toBe(`${BOOT_ID}:30000`);
    expect(host.commands).toEqual([]);
  });

  it('differs across boots even when the ticks match', async () => {
    const stat = statWithStartTicks('30000');
    const first = await readProcessStartToken(
      42,
      new FakeTokenHost('linux', { '/proc/42/stat': stat, '/proc/sys/kernel/random/boot_id': 'a' })
    );
    const second = await readProcessStartToken(
      42,
      new FakeTokenHost('linux', { '/proc/42/stat': stat, '/proc/sys/kernel/random/boot_id': 'b' })
    );

    expect(first).not.toBe(second);
  });

  it('is undefined on Linux when a file is missing or malformed', async () => {
    expect(await readProcessStartToken(42, new FakeTokenHost('linux'))).toBeUndefined();
    expect(
      await readProcessStartToken(
        42,
        new FakeTokenHost('linux', {
          '/proc/42/stat': 'garbage',
          '/proc/sys/kernel/random/boot_id': BOOT_ID,
        })
      )
    ).toBeUndefined();
  });

  it('asks ps for lstart in the C locale on macOS', async () => {
    const host = new FakeTokenHost('darwin', {}, 'Mon Nov 17 09:15:02 2026\n');

    expect(await readProcessStartToken(42, host)).toBe('Mon Nov 17 09:15:02 2026');
    expect(host.commands).toEqual([['ps', '-o', 'lstart=', '-p', '42']]);
    // Without the pinned zone a hub and a CLI in different zones would read different tokens
    // for one process, and the live hub would be judged stale.
    expect(host.envs).toEqual([{ LC_ALL: 'C', TZ: 'UTC' }]);
  });

  it('accepts a single-digit day, which ps pads with a space', async () => {
    const host = new FakeTokenHost('darwin', {}, 'Thu Nov  5 09:15:02 2026\n');

    expect(await readProcessStartToken(42, host)).toBe('Thu Nov  5 09:15:02 2026');
  });

  it.each(['', '\n', 'ps: no such process', '09:15'])(
    'is undefined for macOS output %p (the pid is gone, or the shape changed)',
    async (output) => {
      expect(await readProcessStartToken(42, new FakeTokenHost('darwin', {}, output))).toBe(
        undefined
      );
    }
  );

  it('turns the native creation time into .NET ticks on Windows, with no spawn', async () => {
    // 134_507_000_000_000_000 FILETIME ticks plus the 1601 to 0001 offset.
    const host = new FakeTokenHost('win32', {}, undefined, 134_507_000_000_000_000n);

    expect(await readProcessStartToken(42, host)).toBe('639418232000000000');
    expect(host.creationTimeQueries).toEqual([42]);
    expect(host.commands).toEqual([]);
  });

  it('is undefined on Windows when the process cannot be opened or queried', async () => {
    expect(await readProcessStartToken(42, new FakeTokenHost('win32'))).toBeUndefined();
  });

  it('is undefined when the native read throws, as when kernel32 cannot load', async () => {
    const host = new FakeTokenHost('win32', {}, undefined, new Error('dlopen kernel32.dll failed'));

    expect(await readProcessStartToken(42, host)).toBeUndefined();
  });

  it.each([0, 1, -1, Number.NaN, 1.5])('never queries for pid %p', async (pid) => {
    const host = new FakeTokenHost('darwin', {}, 'Mon Nov 17 09:15:02 2026');

    expect(await readProcessStartToken(pid, host)).toBeUndefined();
    expect(host.commands).toEqual([]);
  });

  it('reads the same token twice for this process', async () => {
    const own = await readProcessStartToken(process.pid);
    const again = await readProcessStartToken(process.pid);

    expect(own, 'expected a start token for this process | received: undefined').toBeDefined();
    expect(again).toBe(own);
  });
});

describe('REAL_START_TIME_HOST.run', () => {
  it('resolves undefined for a command that exits non-zero', async () => {
    const command = process.platform === 'win32' ? ['cmd', '/c', 'exit 3'] : ['sh', '-c', 'exit 3'];

    expect(await REAL_START_TIME_HOST.run(command)).toBeUndefined();
  });

  it('passes env entries through to the command', async () => {
    const command =
      process.platform === 'win32'
        ? ['cmd', '/c', 'echo %MANGO_TOKEN_PROBE%']
        : ['sh', '-c', 'echo $MANGO_TOKEN_PROBE'];

    const output = await REAL_START_TIME_HOST.run(command, { MANGO_TOKEN_PROBE: 'probe-value' });

    expect(output?.trim()).toBe('probe-value');
  });
});
