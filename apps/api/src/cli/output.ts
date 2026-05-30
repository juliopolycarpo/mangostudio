/**
 * Thin wrapper for plain-text CLI output, so user-facing printing flows through
 * one place: stdout for normal output, stderr for errors. Keeps the rest of the
 * CLI free of scattered console calls (per the project's wrap-globals rule).
 */

/** Print a line to stdout. // Usage: writeLine('MangoStudio is running.') */
export function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Print a line to stderr. // Usage: writeError('Another instance is already running.') */
export function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}
