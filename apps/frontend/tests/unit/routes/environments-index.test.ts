/**
 * `/environments` is the umbrella's own landing page, not a forward to whichever
 * tab happened to be first.
 *
 * A `beforeLoad` left behind here would win over the component and send every
 * visit straight back to Toolchains, which is exactly the behaviour the overview
 * replaces — so its absence is the assertion.
 */

import { describe, expect, it } from 'vitest';
import { OverviewPage } from '../../../src/features/environments/components/OverviewPage';
import { Route as EnvironmentsIndexRoute } from '../../../src/routes/_authenticated/environments/index';

interface RouteInternals {
  readonly options: {
    readonly beforeLoad?: unknown;
    readonly component?: unknown;
    readonly loader?: unknown;
  };
}

describe('/environments', () => {
  const { options } = EnvironmentsIndexRoute as unknown as RouteInternals;

  it('renders the overview rather than redirecting to a tab', () => {
    expect(options.beforeLoad).toBeUndefined();
    expect(options.component).toBe(OverviewPage);
  });

  it('warms the queries its sections read instead of blocking on them', () => {
    // Prefetch, never `ensure`: each section renders its own pending state, so
    // navigation must not wait on the slowest probe of five.
    expect(typeof options.loader).toBe('function');
  });
});
