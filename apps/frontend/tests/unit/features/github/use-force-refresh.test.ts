/**
 * `useForceRefresh`'s one-shot bypass signal.
 *
 * `refetch()` cannot hand its queryFn an argument, so a refresh button has no
 * query-key-based way to say "bypass the server's cache for this one call."
 * This hook is the workaround: a ref the queryFn reads at call time, flipped
 * true only for the request the button itself caused.
 */

import { describe, expect, it, jest } from 'bun:test';
import { useForceRefresh } from '../../../../src/features/github/hooks/use-force-refresh';
import { act, renderHook } from '../../../support/harness/render';

describe('useForceRefresh', () => {
  it('reads false until a trigger is in flight', () => {
    const { result } = renderHook(() => useForceRefresh());
    expect(result.current.read()).toBe(false);
  });

  it('reads true for the triggered refetch and false again once it settles', async () => {
    const { result } = renderHook(() => useForceRefresh());
    let duringRefetch = false;
    const refetch = jest.fn(() => {
      duringRefetch = result.current.read();
      return Promise.resolve();
    });

    await act(async () => {
      await result.current.trigger(refetch);
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(duringRefetch).toBe(true);
    expect(result.current.read()).toBe(false);
  });

  it('clears the flag even when the refetch it wrapped rejects', async () => {
    const { result } = renderHook(() => useForceRefresh());
    const refetch = jest.fn(() => Promise.reject(new Error('network down')));

    await act(async () => {
      await expect(result.current.trigger(refetch)).rejects.toThrow('network down');
    });

    expect(result.current.read()).toBe(false);
  });
});
