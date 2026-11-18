/**
 * A Windows process's creation time, read in-process with `GetProcessTimes` through `bun:ffi`.
 * A query that spawned `powershell.exe` for this took longer than the caller's 5 s budget on a
 * loaded runner; the native call answers in microseconds and has no window to hide.
 *
 * `bun:ffi` is loaded on first use, so no other platform pays for it. The compiled hub keeps it:
 * `bun build --compile --aot --trim` retains an API the code calls, and `dlopen` is called here.
 */

/** `PROCESS_QUERY_LIMITED_INFORMATION`: enough for `GetProcessTimes`, and granted for processes
 * (other users', services) that a full query access right is refused for. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** Four `FILETIME`s (creation, exit, kernel, user), 8 bytes each. */
const PROCESS_TIMES_BYTES = 32;

async function loadKernel32() {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const { symbols } = dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  return { symbols, ptr };
}

let kernel32: ReturnType<typeof loadKernel32> | undefined;

/**
 * The creation time of `pid` as a `FILETIME` (100 ns ticks since 1601-01-01 UTC), or `undefined`
 * when the process cannot be opened (gone, or access denied) or its times cannot be read.
 * Throws only when `kernel32.dll` cannot be loaded, which the caller treats as "unreadable".
 *
 * @example
 * await readWindowsCreationFileTime(process.pid); // 133_9xx_xxx_xxx_xxx_xxxn
 */
export async function readWindowsCreationFileTime(pid: number): Promise<bigint | undefined> {
  kernel32 ??= loadKernel32();
  const { symbols, ptr } = await kernel32;

  const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === null) return undefined;
  try {
    const times = new Uint8Array(PROCESS_TIMES_BYTES);
    // All four out-parameters are required, so each gets its own slot in one buffer.
    const read = symbols.GetProcessTimes(
      handle,
      ptr(times, 0),
      ptr(times, 8),
      ptr(times, 16),
      ptr(times, 24)
    );
    if (read === 0) return undefined;
    // A FILETIME is a little-endian low DWORD then high DWORD: one little-endian 64-bit value.
    return new DataView(times.buffer).getBigUint64(0, true);
  } finally {
    symbols.CloseHandle(handle);
  }
}
