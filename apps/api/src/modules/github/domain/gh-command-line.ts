/**
 * What a Windows runtime can be handed on one command line.
 *
 * `CreateProcess` caps the whole command line at 32,767 UTF-16 code units,
 * including the executable and the separators — a limit of the OS, not of `gh`,
 * so it applies before `gh` starts and reports itself as a spawn failure with
 * nothing in it about which argument was too long.
 *
 * The registry sends every free-text value as argv on purpose
 * (`gh-command-registry.ts`), and a pull request body is contractually allowed
 * 60,000 characters. So a large enough body is a `pr create` that cannot run on
 * a Windows runtime, and the honest thing is to say that rather than to
 * truncate what somebody wrote or let `Bun.spawn` fail opaquely.
 */

/**
 * Headroom under the OS cap for the parts this count cannot see: the resolved
 * `gh.exe` path, the quoting `CreateProcess` adds around arguments containing
 * spaces, and the trailing NUL.
 */
const WINDOWS_COMMAND_LINE_BUDGET = 30_000;

/**
 * Length of the command line these arguments would build, one space apiece.
 *
 * UTF-16 code units, which is what Windows counts — `String.length` already
 * measures those, so an emoji in a title costs the two it really costs.
 *
 * @example
 * ghCommandLineLength(['pr', 'create']); // 10
 */
export function ghCommandLineLength(args: readonly string[]): number {
  return args.reduce((total, arg) => total + arg.length + 1, 0);
}

/**
 * True when this argv cannot be spawned on a Windows target.
 *
 * Only ever asked of a `win32` runtime: every other platform's limit is orders
 * of magnitude higher (Linux allows ~2MB across the whole argv), and refusing
 * there would reject a body the machine would have accepted.
 *
 * @example
 * exceedsWindowsCommandLine(['pr', 'create', `--body=${'x'.repeat(40_000)}`]); // true
 */
export function exceedsWindowsCommandLine(args: readonly string[]): boolean {
  return ghCommandLineLength(args) > WINDOWS_COMMAND_LINE_BUDGET;
}
