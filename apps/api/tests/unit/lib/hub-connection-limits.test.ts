import { describe, expect, it } from 'bun:test';

import {
  HUB_HANDLER_IDLE_TIMEOUT_SECONDS,
  HUB_IDLE_TIMEOUT_SECONDS,
  hubListenOptions,
  SSE_KEEPALIVE_FRAME,
  SSE_KEEPALIVE_INTERVAL_MS,
} from '../../../src/lib/hub-connection-limits';

// The WSL2 localhost relay (issue #994) was measured dropping a quiet stream
// 8 s into the gap at the earliest.
const EARLIEST_INTERMEDIARY_IDLE_KILL_MS = 8_000;

describe('hub connection limits', () => {
  it('beats at least twice inside the listener idle timeout', () => {
    // Two beats per window, so one late timer tick still lands in time.
    expect(SSE_KEEPALIVE_INTERVAL_MS * 2).toBeLessThanOrEqual(HUB_IDLE_TIMEOUT_SECONDS * 1_000);
  });

  it('beats before the earliest intermediary idle kill', () => {
    expect(SSE_KEEPALIVE_INTERVAL_MS).toBeLessThan(EARLIEST_INTERMEDIARY_IDLE_KILL_MS);
  });

  it('frames the keepalive as an SSE comment', () => {
    expect(new TextDecoder().decode(SSE_KEEPALIVE_FRAME)).toBe(': keepalive\n\n');
  });

  it("keeps the handler idle timeout above the listener default and inside Bun's documented cap", () => {
    expect(HUB_HANDLER_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(HUB_IDLE_TIMEOUT_SECONDS);
    expect(HUB_HANDLER_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  it('gives the listener the idle timeout the keepalive is sized for', () => {
    expect(hubListenOptions('127.0.0.1', 4321)).toEqual({
      hostname: '127.0.0.1',
      port: 4321,
      reusePort: false,
      idleTimeout: HUB_IDLE_TIMEOUT_SECONDS,
    });
  });
});
