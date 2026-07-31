import type { RuntimeErrorCode, RuntimeProtocolVersion } from './schemas';

export class RuntimeProtocolError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'RuntimeProtocolError';
  }
}

interface ProtocolVersionParts {
  readonly major: number;
  readonly minor: number;
}

/**
 * Requires the hub and runtime to agree on the protocol's major/minor pair.
 * Patch versions remain compatible so protocol-only fixes do not strand a
 * runtime from the same feature release.
 */
export function assertRuntimeProtocolCompatible(
  hubVersion: RuntimeProtocolVersion,
  runtimeVersion: RuntimeProtocolVersion
): void {
  const hub = parseProtocolVersion(hubVersion);
  const runtime = parseProtocolVersion(runtimeVersion);
  if (hub.major === runtime.major && hub.minor === runtime.minor) return;

  throw new RuntimeProtocolError(
    'PROTOCOL_MISMATCH',
    `Runtime protocol ${runtimeVersion} is incompatible with hub protocol ${hubVersion}. ` +
      'Update MangoStudio so the hub and runtime come from the same release.',
    { hubVersion, runtimeVersion }
  );
}

function parseProtocolVersion(version: RuntimeProtocolVersion): ProtocolVersionParts {
  const [majorText, minorText] = version.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new RuntimeProtocolError(
      'PROTOCOL_MISMATCH',
      `Runtime protocol version "${version}" is invalid. Expected a numeric major.minor version.`,
      { version }
    );
  }
  return { major, minor };
}
