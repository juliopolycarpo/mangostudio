import { Kysely } from 'kysely';

import { startServer } from '../../../src/server/start-server';

// A database whose driver close rejects, as a failed shutdown would see it. The fixture keeps
// the process alive after `stop` rejects so the parent can probe the capture lock the stop left
// behind; at exit the OS would release it and hide a leak.
const DATABASE_CLOSE_FAILURE = 'fixture database close failed';
Kysely.prototype.destroy = () => Promise.reject(new Error(DATABASE_CLOSE_FAILURE));

const handle = await startServer();
const release = Promise.withResolvers<void>();
process.once('SIGUSR2', () => release.resolve());
const watchdog = setTimeout(
  () => release.reject(new Error('Parent never released the fixture.')),
  15_000
);
try {
  const outcome = await handle.stop().then(
    () => 'stop resolved',
    (error: unknown) =>
      `stop rejected with: ${error instanceof Error ? error.message : String(error)}`
  );
  console.warn(`shutdown-fixture: ${outcome}`);
  await release.promise;
} finally {
  clearTimeout(watchdog);
}
