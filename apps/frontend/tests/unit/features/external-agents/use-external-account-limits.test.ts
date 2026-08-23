/**
 * Two things make this hook interesting, and they are all this asserts.
 *
 * The first is the account changing out from under an in-flight request: the
 * snapshot is keyed by the identity it was fetched for, and a value belonging to
 * a different identity must be unreadable — during the render before the switch
 * has settled, and after a request lands for an account nobody is looking at any
 * more.
 *
 * The second is that the state is shared. The header pill and the selector's
 * chip both mount, and they must see one cold read, one snapshot and one refresh
 * lock — a refresh in either is a refresh in both. A refresh that comes back
 * empty is a non-answer and leaves what is cached alone.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type {
  ExternalAccountLimits,
  ExternalAgentDescriptor,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import { useExternalAccountLimits } from '../../../../src/features/external-agents/use-external-account-limits';
import { act, flushAsyncRender, renderHook } from '../../../support/harness/render';

// Spread rather than replaced: `bun test` resolves the whole namespace, so a
// factory returning only these two breaks every other consumer of the module.
const actualExternalAgentService = await import('@/services/external-agent-service');

interface Deferred {
  resolve: (limits?: ExternalAccountLimits | null) => void;
  promise: Promise<{ limits?: ExternalAccountLimits | null }>;
}

function deferred(): Deferred {
  let resolve!: (limits?: ExternalAccountLimits | null) => void;
  const promise = new Promise<{ limits?: ExternalAccountLimits | null }>((settle) => {
    resolve = (limits) => settle({ limits });
  });
  return { resolve, promise };
}

/** One queue per call site, so a test can settle a load and a refresh apart. */
const pendingLoads: Deferred[] = [];
const pendingRefreshes: Deferred[] = [];

mock.module('@/services/external-agent-service', () => ({
  ...actualExternalAgentService,
  getExternalAccountLimits: () => {
    const next = deferred();
    pendingLoads.push(next);
    return next.promise;
  },
  refreshExternalAccountLimits: () => {
    const next = deferred();
    pendingRefreshes.push(next);
    return next.promise;
  },
}));

function descriptorFor(fingerprint: string): ExternalAgentDescriptor {
  return {
    targetId: 'codex',
    environmentId: 'local',
    installed: true,
    authState: 'signed-in',
    capabilities: NO_EXTERNAL_AGENT_CAPABILITIES,
    supportedConfigurations: [],
    account: { fingerprint },
  } as unknown as ExternalAgentDescriptor;
}

const ACCOUNT_A = descriptorFor('account-a');
const ACCOUNT_B = descriptorFor('account-b');

function limitsFixture(usedPercent: number): ExternalAccountLimits {
  return { targetId: 'codex', windows: [{ usedPercent }], observedAtMs: 1_787_000_000_000 };
}

afterEach(() => {
  pendingLoads.length = 0;
  pendingRefreshes.length = 0;
});

/**
 * `renderHook`'s `result.current` only exposes the *last* render of a batch, and
 * the stale-paint window is one render wide — so every render's value is
 * recorded on the way past instead.
 */
function renderForAccount(descriptor: ExternalAgentDescriptor) {
  const painted: (ExternalAccountLimits | null | undefined)[] = [];
  const hook = renderHook(
    ({ descriptor: current }: { descriptor: ExternalAgentDescriptor }) => {
      const state = useExternalAccountLimits(current);
      painted.push(state.limits);
      return state;
    },
    { initialProps: { descriptor } }
  );
  return { ...hook, painted };
}

describe('useExternalAccountLimits', () => {
  it('drops the previous account snapshot on the first render after a switch', async () => {
    const { result, rerender, painted } = renderForAccount(ACCOUNT_A);
    pendingLoads[0]?.resolve(limitsFixture(40));
    await flushAsyncRender();
    expect(result.current.limits).toEqual(limitsFixture(40));

    // Every render from the switch onwards, including the one before the effect
    // that re-anchors the snapshot commits.
    const beforeSwitch = painted.length;
    act(() => rerender({ descriptor: ACCOUNT_B }));
    // `toContainEqual`, not `toContain`: each fixture call is a fresh object,
    // so reference containment would pass no matter what got painted.
    expect(painted.slice(beforeSwitch)).not.toContainEqual(limitsFixture(40));
    expect(result.current.limits).toBeUndefined();
  });

  it('discards a load that lands after the account changed', async () => {
    const { result, rerender } = renderForAccount(ACCOUNT_A);
    act(() => rerender({ descriptor: ACCOUNT_B }));
    expect(pendingLoads.length).toBe(2);

    pendingLoads[0]?.resolve(limitsFixture(99));
    await flushAsyncRender();
    expect(result.current.limits).toBeUndefined();

    pendingLoads[1]?.resolve(limitsFixture(40));
    await flushAsyncRender();
    expect(result.current.limits).toEqual(limitsFixture(40));
  });

  it('releases the refresh lock when the account changes mid-request', async () => {
    const { result, rerender } = renderForAccount(ACCOUNT_A);
    pendingLoads[0]?.resolve(limitsFixture(40));
    await flushAsyncRender();

    act(() => {
      result.current.refresh();
    });
    // The lock is read off the mutation cache, and React Query announces cache
    // changes through its own `setTimeout(cb, 0)` — so it is raised a macrotask
    // after the click, not inside it.
    await flushAsyncRender();
    expect(result.current.refreshing).toBe(true);

    // A's refresh is still in flight. B must not inherit its lock — the caller
    // renders the refresh control `disabled` off this flag.
    act(() => rerender({ descriptor: ACCOUNT_B }));
    expect(result.current.refreshing).toBe(false);

    // And settling A's request afterwards must not resurrect it either.
    pendingRefreshes[0]?.resolve(limitsFixture(88));
    await flushAsyncRender();
    expect(result.current.refreshing).toBe(false);
    expect(result.current.limits).toBeUndefined();
  });

  it('keeps the previous snapshot when a refresh comes back with nothing', async () => {
    const { result } = renderForAccount(ACCOUNT_A);
    pendingLoads[0]?.resolve(limitsFixture(40));
    await flushAsyncRender();

    act(() => {
      result.current.refresh();
    });
    // The request is not issued inside `mutate()` — it starts a turn later, so
    // the queue is empty until this flush.
    await flushAsyncRender();

    // What the hub answers when the vendor probe failed or timed out: HTTP 200
    // with no `limits` at all. That is a non-answer, not "this account has no
    // quota", and it must not erase what the chip is already showing.
    pendingRefreshes[0]?.resolve(undefined);
    await flushAsyncRender();
    expect(result.current.limits).toEqual(limitsFixture(40));
    expect(result.current.refreshing).toBe(false);
  });

  it('shares one snapshot and one load between consumers of the same account', async () => {
    const { result } = renderHook(() => ({
      chip: useExternalAccountLimits(ACCOUNT_A),
      pill: useExternalAccountLimits(ACCOUNT_A),
    }));

    // The header pill and the selector's chip mount together; the cold read is
    // one request between them, not one each.
    expect(pendingLoads.length).toBe(1);
    pendingLoads[0]?.resolve(limitsFixture(40));
    await flushAsyncRender();
    expect(result.current.pill.limits).toEqual(limitsFixture(40));

    // And a refresh started from either one settles into both.
    act(() => {
      result.current.chip.refresh();
    });
    await flushAsyncRender();
    expect(result.current.pill.refreshing).toBe(true);

    pendingRefreshes[0]?.resolve(limitsFixture(88));
    await flushAsyncRender();
    expect(result.current.chip.limits).toEqual(limitsFixture(88));
    expect(result.current.pill.limits).toEqual(limitsFixture(88));
  });
});
