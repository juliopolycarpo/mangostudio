import type { RuntimeProtocolVersion } from '@mangostudio/shared/runtime-protocol';
import { RuntimeHost } from './host';
import { createLocalRuntimeManifest } from './manifest';
import { createRuntimeMethodHandlers } from './registry';

export function createLocalRuntimeHost(options: {
  readonly runtimeVersion: string;
  readonly protocolVersion?: RuntimeProtocolVersion;
}): RuntimeHost {
  return new RuntimeHost({
    runtimeVersion: options.runtimeVersion,
    manifest: createLocalRuntimeManifest(),
    handlers: createRuntimeMethodHandlers(),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
  });
}
