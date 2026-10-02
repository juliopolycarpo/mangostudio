import { describe, expect, it } from 'bun:test';
import { INTEROP_ENABLED, peerBinary } from './support';

const describeInterop = INTEROP_ENABLED ? describe : describe.skip;

describeInterop('interop: Cargo peer executable', () => {
  it('returns the executable Cargo built, including redirected target directories', async () => {
    const binary = await peerBinary();
    expect(await Bun.file(binary).exists()).toBe(true);
  }, 60_000);
});
