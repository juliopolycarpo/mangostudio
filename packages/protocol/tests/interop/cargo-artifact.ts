/**
 * Uses Cargo's build receipt rather than guessing its target directory,
 * profile, target triple or platform-specific executable suffix.
 *
 * @example
 * const binary = peerExecutable(cargoStdout);
 */
export function peerExecutable(output: string): string {
  const executables = new Set<string>();
  for (const line of output.split('\n')) {
    // Procedural macros can print non-JSON output even in Cargo's JSON mode.
    if (!line.trimStart().startsWith('{')) continue;
    let message: {
      reason?: unknown;
      target?: { name?: unknown; kind?: unknown };
      executable?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(`Cargo reported ${JSON.stringify(line)}; expected a JSON build message`);
    }
    if (
      message.reason !== 'compiler-artifact' ||
      message.target?.name !== 'conformance_peer' ||
      !Array.isArray(message.target.kind) ||
      !message.target.kind.includes('example')
    ) {
      continue;
    }
    if (typeof message.executable !== 'string' || message.executable.length === 0) {
      throw new Error(
        `Cargo reported executable ${JSON.stringify(message.executable)}; expected a nonempty conformance_peer example executable path`
      );
    }
    executables.add(message.executable);
  }
  const [executable] = executables;
  if (executables.size !== 1 || !executable) {
    throw new Error(
      `Cargo reported executable paths ${JSON.stringify([...executables])}; expected exactly one conformance_peer example executable`
    );
  }
  return executable;
}
