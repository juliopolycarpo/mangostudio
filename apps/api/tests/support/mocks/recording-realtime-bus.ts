import type { RealtimeServerMessage } from '@mangostudio/shared/realtime';
import { ACTIVITY_TOPIC } from '@mangostudio/shared/realtime';
import {
  type getRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';

export interface PublishedRealtimeMessage {
  readonly userId: string;
  readonly message: RealtimeServerMessage;
}

/** Records what production code announces, without a socket on the other end. */
export class RecordingRealtimeBus {
  readonly published: PublishedRealtimeMessage[] = [];

  publish(userId: string, message: RealtimeServerMessage): void {
    this.published.push({ userId, message });
  }

  /**
   * The activity-topic invalidations addressed to one user, in publish order.
   *
   * @example
   * expect(bus.activityFramesFor(user.id)).toHaveLength(1);
   */
  activityFramesFor(userId: string): PublishedRealtimeMessage[] {
    return this.published.filter(
      (entry) =>
        entry.userId === userId &&
        entry.message.type === 'invalidate' &&
        entry.message.topic === ACTIVITY_TOPIC
    );
  }

  /**
   * Polls until `userId` has at least `count` activity frames, then returns
   * them. For the seams that publish from a promise the caller deliberately did
   * not await — a turn must not wait on the note about it — where reading
   * `activityFramesFor` straight after the call races the publish.
   *
   * Rejects with the observed count on timeout, so a genuine regression reads as
   * "expected 1, saw 0" rather than as an anonymous timeout.
   *
   * @example
   * await sendTextMessage(input, db);
   * expect(await bus.waitForActivityFrames(user.id, 1)).toHaveLength(1);
   */
  async waitForActivityFrames(
    userId: string,
    count: number,
    timeoutMs = 2000
  ): Promise<PublishedRealtimeMessage[]> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const frames = this.activityFramesFor(userId);
      if (frames.length >= count) return frames;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(
      `Expected at least ${count} activity frame(s) for user "${userId}" within ${timeoutMs}ms, saw ${this.activityFramesFor(userId).length}`
    );
  }
}

/**
 * Swaps the process-wide realtime bus for a recorder. Pair every call with
 * `restoreRealtimeBus()` in `afterEach`: the bus is a module singleton, so a
 * recorder left installed silences every later test in the same process.
 *
 * @example
 * const bus = installRecordingRealtimeBus();
 * await compactChatUseCase(input, db);
 * expect(bus.activityFramesFor(userId)).toHaveLength(1);
 */
export function installRecordingRealtimeBus(): RecordingRealtimeBus {
  const bus = new RecordingRealtimeBus();
  setRealtimeBusForTests(bus as unknown as ReturnType<typeof getRealtimeBus>);
  return bus;
}

/** Hands the process back its real bus. */
export function restoreRealtimeBus(): void {
  setRealtimeBusForTests(undefined);
}
