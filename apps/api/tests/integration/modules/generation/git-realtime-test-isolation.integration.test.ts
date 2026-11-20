/**
 * #2662: a git refresh a test armed must not fire in a later test.
 *
 * A file mutation arms a 500 ms trailing refresh. Left pending past its test,
 * it fired in the next file of the unisolated lane, looked the chat's
 * repository up through Local as the old file's user, and withdrew the new
 * file's identity attestation mid-test. The shared preload clears it after
 * every test; these two cases run in order to see that across a test boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';

import { scheduleGitFileMutationInvalidation } from '../../../../src/modules/git/application/git-realtime-service';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../../src/services/realtime/realtime-bus';

const LEAKED_TARGET = {
  userId: 'git-isolation-user',
  chatId: 'git-isolation-chat',
  environmentId: 'local',
} as const;
/** Past the 500 ms debounce in `git-realtime-service.ts`, with slack. */
const OUTLAST_DEBOUNCE_MS = 800;

describe('a git refresh armed in one test', () => {
  const published: RealtimeInvalidateEvent[] = [];

  beforeAll(() => {
    const bus = createRealtimeBus();
    bus.subscribe(LEAKED_TARGET.userId, (event) => published.push(event));
    setRealtimeBusForTests(bus);
  });

  afterAll(() => {
    setRealtimeBusForTests(undefined);
  });

  it('is armed by a file mutation and left pending when the test ends', () => {
    scheduleGitFileMutationInvalidation(LEAKED_TARGET);
    expect(published).toEqual([]);
  });

  it('never fires in the test after it', async () => {
    await Bun.sleep(OUTLAST_DEBOUNCE_MS);
    expect(
      published,
      `expected no frame for ${LEAKED_TARGET.chatId} after its test ended | received: ${JSON.stringify(published)}`
    ).toEqual([]);
  });
});
