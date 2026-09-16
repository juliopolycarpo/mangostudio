/**
 * The string work the transports share, kept apart from any of them: a module
 * that only builds an argv or reads a diagnostic must not pull `node:` in
 * behind a helper. Nothing here imports `node:`.
 */

/**
 * The last line of a diagnostic that says anything, which is where a program
 * that failed to start puts its reason.
 *
 * @example
 * lastNonEmptyLine('starting\nconfig missing\n'); // 'config missing'
 */
export function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line.length > 0) return line;
  }
  return undefined;
}
