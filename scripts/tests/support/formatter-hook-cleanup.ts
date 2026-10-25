import { writeFile } from 'node:fs/promises';
import { stopPath } from './fake-rustfmt-markers';

interface FormatterHook {
  readonly exited: Promise<unknown>;
  kill(signal: NodeJS.Signals): void;
}

type FormatterMarker = readonly [marker: string, who: string];

interface FormatterCleanup {
  requestStop(marker: string): Promise<void>;
  stillBeating(marker: string): Promise<boolean>;
}

async function awaitStoppedFormatter(
  [marker, who]: FormatterMarker,
  cleanup: FormatterCleanup
): Promise<void> {
  const observations = 4;
  for (let attempt = 0; attempt < observations; attempt++) {
    if (!(await cleanup.stillBeating(marker))) return;
  }
  throw new Error(
    `${who} (${marker}): expected a stopped heartbeat within ${observations} cleanup observations | received: still beating`
  );
}

async function stopFormatterFixture(
  hook: FormatterHook,
  markers: readonly FormatterMarker[],
  cleanup: FormatterCleanup
): Promise<void> {
  // Publish both identities before stopping the hook: a child that has not
  // written a marker yet must see its own request when it eventually starts.
  const requests = await Promise.allSettled(
    markers.map(async ([marker]) => cleanup.requestStop(marker))
  );
  try {
    // The owned handle cannot accidentally signal a reused hook pid. Its
    // cancellation handler also stops its formatter process group.
    hook.kill('SIGTERM');
  } catch {
    // The hook may have exited before failure cleanup began.
  }
  await hook.exited;
  // No new descendants can be launched after hook settlement. A launched child
  // that starts late still observes its marker-specific stop request.
  const results = await Promise.allSettled(
    markers.map((marker) => awaitStoppedFormatter(marker, cleanup))
  );
  const failures = [...requests, ...results].flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length) throw new AggregateError(failures, 'formatter fixture cleanup failed');
}

/**
 * Ask a controlled formatter to stop without signaling a possibly reused pid.
 * @example
 * await requestFormatterStop('/tmp/started.json');
 */
export async function requestFormatterStop(marker: string): Promise<void> {
  await writeFile(stopPath(marker), '');
}

/**
 * Retain ownership of a hook and its marker-identified formatter descendants
 * through every assertion failure.
 * @example
 * await withFormatterHookCleanup(hook, markers, checkCancellation, cleanup);
 */
export async function withFormatterHookCleanup<T>(
  hook: FormatterHook,
  markers: readonly FormatterMarker[],
  run: () => Promise<T>,
  cleanup: FormatterCleanup
): Promise<T> {
  let result: { readonly value: T } | { readonly error: unknown };
  try {
    result = { value: await run() };
  } catch (error) {
    result = { error };
  }
  try {
    await stopFormatterFixture(hook, markers, cleanup);
  } catch (error) {
    if (!('error' in result)) throw error;
    throw new AggregateError(
      [result.error, error],
      'formatter hook assertion and fixture cleanup failed',
      { cause: result.error }
    );
  }
  if ('error' in result) throw result.error;
  return result.value;
}
