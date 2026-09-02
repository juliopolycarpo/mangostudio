/**
 * `/environments/machine` is the "This machine" tab: the page itself is lazy,
 * and the route warms its three queries without blocking on any of them.
 */

import { describe, expect, it } from 'bun:test';
import { en } from '@mangostudio/shared/i18n';
import { environmentNavEntries } from '../../../src/features/environments/environments-nav';
import { MachinePage } from '../../../src/features/environments/machine/components/MachinePage';
import { Route as MachineRoute } from '../../../src/routes/_authenticated/environments/machine';
import { Route as MachineLazyRoute } from '../../../src/routes/_authenticated/environments/machine.lazy';

interface RouteInternals {
  readonly options: {
    readonly beforeLoad?: unknown;
    readonly component?: unknown;
    readonly loader?: unknown;
  };
}

describe('/environments/machine', () => {
  const { options } = MachineRoute as unknown as RouteInternals;
  const { options: lazyOptions } = MachineLazyRoute as unknown as RouteInternals;

  it('renders the machine page lazily', () => {
    expect(options.beforeLoad).toBeUndefined();
    expect(lazyOptions.component).toBe(MachinePage);
  });

  it('prefetches instead of blocking', () => {
    expect(typeof options.loader).toBe('function');
  });

  it('has a tab in the environments strip', () => {
    const entry = environmentNavEntries(en.environments.tabs).find(
      (tab) => tab.to === '/environments/machine'
    );
    expect(entry?.label).toBe('This machine');
  });
});
