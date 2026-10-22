import { dlopen, FFIType, type Pointer, ptr } from 'bun:ffi';

function loadKernel() {
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
  return symbols;
}
let loaded: ReturnType<typeof loadKernel> | undefined;
function kernel() {
  loaded ??= loadKernel();
  return loaded;
}

function requireSuccess(value: unknown, operation: string): void {
  if (!value) throw new Error(`${operation} failed: Windows error ${kernel().GetLastError()}`);
}

/** Keep the pre-capture cumulative process total immutable through termination.
 * @example coverage.capture(totalBeforeList); coverage.verify(totalAfterWait);
 */
export class FixtureJobCoverage {
  private baseline: number | undefined;
  private invalid: string | undefined;

  capture(total: number): void {
    this.baseline ??= total;
    this.verify(total);
  }

  verify(total: number): void {
    if (this.invalid) throw new Error(this.invalid);
    if (this.baseline === undefined || this.baseline === total) return;
    this.invalid = `fixture job process total changed after capture: expected ${this.baseline}, received ${total}; storage retained`;
    throw new Error(this.invalid);
  }

  list(assigned: number, listed: number, bytes: number, capacity: number): void {
    if (assigned === listed && bytes >= 8 + listed * 8 && bytes <= capacity) return;
    this.invalid = `fixture job census incomplete: assigned ${assigned}, listed ${listed}, bytes ${bytes}, capacity ${capacity}; storage retained`;
    throw new Error(this.invalid);
  }
}

export interface FixtureJob {
  readonly name: string;
  stop(): void;
  empty(): boolean;
  close(): void;
}

/** Own native query handles before verification can fail.
 * @example const handle = owner.acquire(openMember, verifyMembership); owner.close();
 */
export class FixtureHandles {
  private readonly owned = new Set<Pointer>();

  constructor(private readonly dispose: (handle: Pointer) => void) {}

  acquire(open: () => Pointer, verify: (handle: Pointer) => void): Pointer {
    const handle = open();
    this.owned.add(handle);
    verify(handle);
    return handle;
  }

  close(): void {
    const errors: unknown[] = [];
    for (const handle of this.owned) {
      try {
        this.dispose(handle);
      } catch (error) {
        errors.push(error);
      }
    }
    this.owned.clear();
    if (errors.length)
      throw new AggregateError(
        errors,
        `fixture handle disposal failed: ${errors.map(String).join('; ')}`
      );
  }
}

/** Create a private job retained by the fixture owner; the command wrapper joins before spawning.
 * @example const job = createFixtureJob(); await run(job.name); job.stop();
 */
export function createFixtureJob(): FixtureJob {
  const symbols = kernel();
  const name = `Local\\mango-fixture-${process.pid}-${crypto.randomUUID()}`;
  const encoded = Buffer.from(`${name}\0`, 'utf16le');
  const job = symbols.CreateJobObjectW(null, ptr(encoded));
  requireSuccess(job, 'CreateJobObjectW');
  const handle = job as Pointer;
  const limits = new Uint8Array(144);
  const members = new Map<number, Pointer>();
  const handles = new FixtureHandles((member) =>
    requireSuccess(symbols.CloseHandle(member), 'CloseHandle(member)')
  );
  const coverage = new FixtureJobCoverage();
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
  const accounting = (): DataView => {
    const data = new Uint8Array(48);
    requireSuccess(
      symbols.QueryInformationJobObject(handle, 1, ptr(data), data.length, null),
      'QueryInformationJobObject(accounting)'
    );
    return new DataView(data.buffer);
  };
  return {
    name,
    stop() {
      try {
        coverage.capture(accounting().getUint32(36, true));
        // Retain same-object wait authority before terminating the exact job.
        const list = new Uint8Array(8 + 8 * 512);
        const returned = new Uint8Array(4);
        requireSuccess(
          symbols.QueryInformationJobObject(handle, 3, ptr(list), list.length, ptr(returned)),
          'QueryInformationJobObject(process list)'
        );
        const view = new DataView(list.buffer);
        coverage.list(
          view.getUint32(0, true),
          view.getUint32(4, true),
          new DataView(returned.buffer).getUint32(0, true),
          list.length
        );
        for (let index = 0; index < view.getUint32(4, true); index++) {
          const pid = Number(view.getBigUint64(8 + index * 8, true));
          if (members.has(pid)) continue;
          const member = handles.acquire(
            () => {
              const opened = symbols.OpenProcess(0x101000, false, pid);
              requireSuccess(opened, 'OpenProcess(same-job settlement)');
              return opened as Pointer;
            },
            (opened) => {
              const belongs = new Uint8Array(4);
              requireSuccess(
                symbols.IsProcessInJob(opened, handle, ptr(belongs)),
                'IsProcessInJob'
              );
              if (!new DataView(belongs.buffer).getUint32(0, true))
                throw new Error(
                  `fixture census PID ${pid} no longer belongs to retained job; storage retained`
                );
            }
          );
          members.set(pid, member);
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
      const signaled = [...members.values()].every((member) => {
        const state = symbols.WaitForSingleObject(member, 0);
        if (state === 0xffffffff)
          throw new Error(`WaitForSingleObject failed: Windows error ${symbols.GetLastError()}`);
        return state === 0;
      });
      if (!signaled) return false;
      const current = accounting();
      coverage.verify(current.getUint32(36, true));
      return current.getUint32(40, true) === 0;
    },
    close() {
      const errors: unknown[] = [];
      try {
        handles.close();
      } catch (error) {
        errors.push(error);
      }
      members.clear();
      try {
        requireSuccess(symbols.CloseHandle(handle), 'CloseHandle(job)');
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          `fixture native handle disposal failed: ${errors.map(String).join('; ')}`
        );
    },
  };
}

/** Join the owner's named job before starting descendants; fail closed if assignment is refused.
 * @example joinFixtureJob(process.argv[2]);
 */
export function joinFixtureJob(name: string): void {
  const symbols = kernel();
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
