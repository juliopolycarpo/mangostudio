import './shutdown-trace-preload';
import './failing-runtime-shutdown';
import { runPendingShutdown } from './pending-runtime-shutdown';

await runPendingShutdown();
