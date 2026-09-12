/**
 * Reads what a service wrote to the runtime's own stderr.
 *
 * `writeRuntimeDiagnostic` takes no injected sink — it is the process's one
 * diagnostic channel by design, and a service reaches it directly — so the
 * channel itself is the seam a test intercepts.
 *
 * @example
 * const lines = await captureDiagnostics(async () => {
 *   await runner.run(command);
 * });
 * expect(lines).toContain('install_failure_unobserved');
 */
export async function captureDiagnostics(run: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const stderr = process.stderr;
  const original = stderr.write.bind(stderr);
  stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof stderr.write;
  try {
    await run();
  } finally {
    stderr.write = original;
  }
  return written.join('');
}
