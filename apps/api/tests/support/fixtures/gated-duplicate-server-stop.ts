import { app } from '../../../src/app';
import { startServer } from '../../../src/server/start-server';

const entered = Promise.withResolvers<void>();
const finish = Promise.withResolvers<void>();
const stopHttp = app.stop.bind(app);

app.stop = async () => {
  const stopped = await stopHttp();
  if (app.server) throw new Error('Expected Elysia to clear its server during stop.');
  entered.resolve();
  await finish.promise;
  return stopped;
};

const handle = await startServer();
process.once('SIGUSR2', () => finish.resolve());
const watchdog = setTimeout(
  () => finish.reject(new Error('Fixture never released the HTTP drain.')),
  15_000
);
try {
  const first = handle.stop();
  await entered.promise;
  const second = handle.stop();
  // A distinct promise is the old, independent stop. Wait for its teardown
  // before asking the parent to observe whether capture ownership escaped.
  if (second !== first) await second;
  console.warn('shutdown-fixture: duplicate stop while HTTP drain is gated');
  await Promise.all([first, second]);
} finally {
  clearTimeout(watchdog);
}
