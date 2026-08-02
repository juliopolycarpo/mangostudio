import type { RuntimeProtocolVersion } from '@mangostudio/shared/runtime-protocol';
import { RuntimeHost } from './host';
import { createLocalRuntimeManifest } from './manifest';
import { createRuntimeMethodHandlers } from './registry';

export function createLocalRuntimeHost(options: {
  readonly runtimeVersion: string;
  readonly protocolVersion?: RuntimeProtocolVersion;
}): RuntimeHost {
  // The registry needs an emitter and the host needs the registry, so the
  // emitter closes over the host rather than being handed it: events raised
  // before `attach` have nowhere to go anyway, and `emit` already drops them.
  let host: RuntimeHost | undefined;
  const registry = createRuntimeMethodHandlers({
    runtimeVersion: options.runtimeVersion,
    emit: (event) => host?.emit(event),
  });

  host = new RuntimeHost({
    runtimeVersion: options.runtimeVersion,
    manifest: createLocalRuntimeManifest(),
    handlers: registry.handlers,
    onClose: () => void registry.close(),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
  });
  return host;
}
