/**
 * The queue between a vendor's callbacks and a turn's iterator.
 *
 * Two properties the adapters depend on: nothing pushed before `finish` is
 * lost, and nothing pushed after it appears.
 */

import { describe, expect, it } from 'bun:test';
import { TurnChannel } from '../../../src/services/external-agents/turn-channel';

async function collect<T>(channel: TurnChannel<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of channel.drain()) seen.push(value);
  return seen;
}

describe('TurnChannel', () => {
  it('yields everything queued before the turn ended', async () => {
    const channel = new TurnChannel<string>();
    channel.push('a');
    channel.push('b');
    channel.finish();

    expect(await collect(channel)).toEqual(['a', 'b']);
  });

  it('yields a falsy value like any other', async () => {
    // Emptiness is a property of the queue, not of the value at its head. A
    // `0`, `''` or `false` is still something the turn pushed, and dropping one
    // would also drop everything queued behind it.
    const channel = new TurnChannel<number>();
    channel.push(0);
    channel.push(1);
    channel.finish();

    expect(await collect(channel)).toEqual([0, 1]);
  });

  it('drops a push that arrives after the turn is over', async () => {
    const channel = new TurnChannel<string>();
    channel.finish();
    channel.push('late');

    expect(await collect(channel)).toEqual([]);
  });

  it('parks until something arrives', async () => {
    const channel = new TurnChannel<string>();
    const collecting = collect(channel);
    await Bun.sleep(5);
    channel.push('late but in time');
    channel.finish();

    expect(await collecting).toEqual(['late but in time']);
  });
});
