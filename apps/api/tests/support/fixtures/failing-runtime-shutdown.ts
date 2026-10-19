import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';

/** Preserve ownership of real runtime children, then exercise the server failure path. */
const realShutdown = RuntimeConnectionManager.prototype.shutdown;
async function rejectRuntimeShutdown(this: RuntimeConnectionManager): Promise<void> {
  await realShutdown.call(this);
  throw new Error('fixture runtime teardown failed');
}

RuntimeConnectionManager.prototype.shutdown = rejectRuntimeShutdown;
