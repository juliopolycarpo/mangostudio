import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { useClipboard } from '../../../src/hooks/use-clipboard';
import { act, renderHook } from '../../support/harness/render';
import {
  advanceTimersByTimeAsync,
  restoreRealTimers,
  useFakeTimers,
} from '../../support/harness/timers';

describe('useClipboard', () => {
  beforeEach(() => {
    useFakeTimers();
  });

  afterEach(async () => {
    await restoreRealTimers();
    jest.restoreAllMocks();
  });

  function stubClipboardWrite(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  }

  it('clears failed after resetAfterMs when clipboard write rejects', async () => {
    stubClipboardWrite(() => Promise.reject(new Error('denied')));

    const { result } = renderHook(() => useClipboard({ resetAfterMs: 1000 }));

    let ok = true;
    await act(async () => {
      ok = await result.current.copy('secret');
    });

    expect(ok).toBe(false);
    expect(result.current.failed).toBe(true);
    expect(result.current.copied).toBe(false);

    await act(async () => {
      await advanceTimersByTimeAsync(1000);
    });

    expect(result.current.failed).toBe(false);
  });

  it('clears copied after resetAfterMs when clipboard write succeeds', async () => {
    stubClipboardWrite(() => Promise.resolve());

    const { result } = renderHook(() => useClipboard({ resetAfterMs: 500 }));

    await act(async () => {
      await result.current.copy('ok');
    });

    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBe(false);

    await act(async () => {
      await advanceTimersByTimeAsync(500);
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe(false);
  });
});
