import { RuntimeConnectionManager } from '../../../src/services/runtime-client/runtime-connection-manager';

/** Inject a teardown failure into an isolated server child, leaving real server cleanup intact. */
function rejectRuntimeShutdown(): Promise<void> {
  return Promise.reject(new Error('fixture runtime teardown failed'));
}

RuntimeConnectionManager.prototype.shutdown = rejectRuntimeShutdown;
