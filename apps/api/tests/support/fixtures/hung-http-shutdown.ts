import { app } from '../../../src/app';
import { requestShutdown } from '../../../src/server/shutdown-request';

app.stop = () => {
  console.warn('shutdown-fixture: HTTP drain will not settle');
  return new Promise(() => undefined);
};

// The real server handler is registered once startup completes. Shorten the
// watchdog for the subprocess test by claiming its first SIGTERM request.
process.once('SIGTERM', () => requestShutdown(2000));
