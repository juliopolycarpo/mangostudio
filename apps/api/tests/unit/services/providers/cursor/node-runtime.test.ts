import { afterEach, describe, expect, it } from 'bun:test';
import {
  detectNodeRuntime,
  resetNodeRuntimeCache,
} from '../../../../../src/services/providers/cursor/node-runtime';

describe('cursor node runtime detector', () => {
  afterEach(() => {
    resetNodeRuntimeCache();
  });

  it('reports availability when node meets the minimum version', () => {
    const status = detectNodeRuntime({ force: true });
    expect(typeof status.available).toBe('boolean');
    if (status.available) {
      expect(status.nodePath).toBeTruthy();
      expect(status.version).toMatch(/^v?\d+\.\d+\.\d+/);
    } else {
      expect(status.reason).toBeTruthy();
    }
  });

  it('caches repeated probes within the TTL window', () => {
    const first = detectNodeRuntime({ force: true });
    const second = detectNodeRuntime();
    expect(second).toEqual(first);
  });
});
