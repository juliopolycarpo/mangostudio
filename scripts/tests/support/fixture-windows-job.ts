import { dlopen, FFIType, type Pointer, ptr } from 'bun:ffi';

const { symbols } = dlopen('kernel32.dll', {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  OpenJobObjectW: { args: [FFIType.u32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
  SetInformationJobObject: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.bool,
  },
  QueryInformationJobObject: {
    args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.bool,
  },
  AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  GetCurrentProcess: { args: [], returns: FFIType.ptr },
  OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
  IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
  CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  GetLastError: { args: [], returns: FFIType.u32 },
});

function requireSuccess(value: unknown, operation: string): void {
  if (!value) throw new Error(`${operation} failed: Windows error ${symbols.GetLastError()}`);
}

export interface FixtureJob {
  readonly name: string;
  stop(): void;
  empty(): boolean;
  close(): void;
}

/** Create a private job retained by the fixture owner; the command wrapper joins before spawning.
 * @example const job = createFixtureJob(); await run(job.name); job.stop();
 */
export function createFixtureJob(): FixtureJob {
  const name = `Local\\mango-fixture-${process.pid}-${crypto.randomUUID()}`;
  const encoded = Buffer.from(`${name}\0`, 'utf16le');
  const job = symbols.CreateJobObjectW(null, ptr(encoded));
  requireSuccess(job, 'CreateJobObjectW');
  const handle = job as Pointer;
  const limits = new Uint8Array(144);
  const members = new Map<number, Pointer>();
  let censusFailed = false;
  new DataView(limits.buffer).setUint32(16, 0x2000, true);
  try {
    requireSuccess(
      symbols.SetInformationJobObject(handle, 9, ptr(limits), limits.length),
      'SetInformationJobObject'
    );
  } catch (error) {
    symbols.CloseHandle(handle);
    throw error;
  }
  return {
    name,
    stop() {
      try {
        // Retain same-object wait authority before terminating the exact job.
        const list = new Uint8Array(8 + 8 * 512);
        requireSuccess(
          symbols.QueryInformationJobObject(handle, 3, ptr(list), list.length, null),
          'QueryInformationJobObject(process list)'
        );
        const view = new DataView(list.buffer);
        for (let index = 0; index < view.getUint32(4, true); index++) {
          const pid = Number(view.getBigUint64(8 + index * 8, true));
          if (members.has(pid)) continue;
          const member = symbols.OpenProcess(0x101000, false, pid);
          if (!member) {
            if (symbols.GetLastError() === 87) continue; // The PID has already disappeared.
            requireSuccess(member, 'OpenProcess(same-job settlement)');
          }
          const belongs = new Uint8Array(4);
          requireSuccess(symbols.IsProcessInJob(member, handle, ptr(belongs)), 'IsProcessInJob');
          if (new DataView(belongs.buffer).getUint32(0, true)) members.set(pid, member as Pointer);
          else symbols.CloseHandle(member);
        }
      } catch (error) {
        censusFailed = true;
        throw error;
      } finally {
        requireSuccess(symbols.TerminateJobObject(handle, 1), 'TerminateJobObject');
      }
    },
    empty() {
      if (censusFailed)
        throw new Error(
          'fixture job member census failed; expected retained same-object wait handles'
        );
      const accounting = new Uint8Array(48);
      requireSuccess(
        symbols.QueryInformationJobObject(handle, 1, ptr(accounting), accounting.length, null),
        'QueryInformationJobObject'
      );
      if (new DataView(accounting.buffer).getUint32(40, true) !== 0) return false;
      return [...members.values()].every((member) => {
        const state = symbols.WaitForSingleObject(member, 0);
        if (state === 0xffffffff)
          throw new Error(`WaitForSingleObject failed: Windows error ${symbols.GetLastError()}`);
        return state === 0;
      });
    },
    close() {
      for (const member of members.values()) symbols.CloseHandle(member);
      members.clear();
      requireSuccess(symbols.CloseHandle(handle), 'CloseHandle');
    },
  };
}

/** Join the owner's named job before starting descendants; fail closed if assignment is refused.
 * @example joinFixtureJob(process.argv[2]);
 */
export function joinFixtureJob(name: string): void {
  const encoded = Buffer.from(`${name}\0`, 'utf16le');
  const job = symbols.OpenJobObjectW(0x0001, false, ptr(encoded));
  requireSuccess(job, 'OpenJobObjectW');
  try {
    requireSuccess(
      symbols.AssignProcessToJobObject(job, symbols.GetCurrentProcess()),
      'AssignProcessToJobObject'
    );
  } finally {
    symbols.CloseHandle(job);
  }
}
