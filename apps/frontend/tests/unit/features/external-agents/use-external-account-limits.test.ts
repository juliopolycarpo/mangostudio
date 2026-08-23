/**
 * The hook's only interesting behaviour is what happens when the account
 * changes out from under an in-flight request, so that is all this asserts.
 *
 * Both cases are about the *reader*: the snapshot carries the identity it was
 * fetched for, and a value belonging to a different identity must be
 * unreadable — during the render before the effect has re-anchored, and after a
 * request settles for an account nobody is looking at any more.
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
  resolve: (limits: ExternalAccountLimits | null) => void;
  promise: Promise<{ limits: ExternalAccountLimits | null }>;
}

function deferred(): Deferred {
  let resolve!: (limits: ExternalAccountLimits | null) => void;
  const promise = new Promise<{ limits: ExternalAccountLimits | null }>((settle) => {
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
});
