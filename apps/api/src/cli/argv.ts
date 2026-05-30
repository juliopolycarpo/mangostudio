/**
 * Extract clean user arguments from process.argv across runtime modes.
 *
 * In a compiled Bun binary process.argv[0] may be "bun" and an internal
 * "/$bunfs/" entry path can appear, so we drop the runtime/exec entries
 * defensively after the standard [exec, entry] prefix.
 */

/** Return user-supplied CLI args, free of runtime/exec noise. // Usage: extractUserArgs(process.argv) */
export function extractUserArgs(rawArgv: string[]): string[] {
  return rawArgv.slice(2).filter((arg) => !isRuntimeArg(arg));
}

/** True for entries injected by the Bun runtime rather than the user. */
function isRuntimeArg(arg: string): boolean {
  return arg.includes('/$bunfs/') || arg === process.execPath;
}
