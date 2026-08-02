/**
 * The runtime's only diagnostic channel. stdout is the protocol stream, so
 * anything meant for a human goes to stderr — which the hub collects for the
 * transports it spawns, and which is a terminal for the ones it does not.
 *
 * Never pass credentials or tool arguments: this text is unredacted by design.
 */
export function writeRuntimeDiagnostic(
  event: string,
  detail: Readonly<Record<string, unknown>> = {}
): void {
  const suffix = Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : '';
  process.stderr.write(`mangostudio-runtime: ${event}${suffix}\n`);
}
