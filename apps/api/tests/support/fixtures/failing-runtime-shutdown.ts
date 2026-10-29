import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';
if (process.env.MANGO_SHUTDOWN_TRACE === '1')
  process.stderr.write(`preload-import-finished ${Math.round(performance.now())}ms\n`);

/** Preserve ownership of real runtime children, then exercise the server failure path. */
const realShutdown = RuntimeConnectionManager.prototype.shutdown;
async function rejectRuntimeShutdown(this: RuntimeConnectionManager): Promise<void> {
  await realShutdown.call(this);
  throw new Error('fixture runtime teardown failed');
}

RuntimeConnectionManager.prototype.shutdown = rejectRuntimeShutdown;
