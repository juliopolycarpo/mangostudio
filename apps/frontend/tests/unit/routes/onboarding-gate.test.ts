/**
 * The gate that stands between an unfinished setup and the rest of the
 * application.
 *
 * Driven by calling the route's own `beforeLoad`, because what is worth
 * asserting is the decision it makes — redirect, pass, or throw — and the three
 * are distinguished by what leaves the function rather than by anything
 * rendered. Mounting the real tree here would drag in the authenticated
 * loader's whole query graph, which is the thing this gate runs *before*.
 */

import { describe, expect, it } from 'bun:test';
import type { AppSettings } from '@mangostudio/shared/app-settings';
import { DEFAULT_APP_SETTINGS, withOnboarding } from '@mangostudio/shared/app-settings';
import { DEFAULT_ONBOARDING_STATE } from '@mangostudio/shared/onboarding';
import { Route as AuthenticatedRoute } from '../../../src/routes/_authenticated';

interface GateContext {
  readonly context: {
    readonly auth: { readonly isAuthenticated: boolean };
    readonly queryClient: { readonly ensureQueryData: () => Promise<AppSettings> };
  };
  readonly location: { readonly href: string };
}

type BeforeLoad = (ctx: GateContext) => Promise<void>;

function beforeLoadOf(route: unknown): BeforeLoad {
  return (route as { options: { beforeLoad: BeforeLoad } }).options.beforeLoad;
}

/** A settings source that answers with one document, or refuses. */
class StubSettingsClient {
  constructor(private readonly answer: AppSettings | Error) {}

  ensureQueryData = (): Promise<AppSettings> =>
    this.answer instanceof Error ? Promise.reject(this.answer) : Promise.resolve(this.answer);
}

function enter(answer: AppSettings | Error, href = '/settings/general'): Promise<void> {
  return beforeLoadOf(AuthenticatedRoute)({
    context: {
      auth: { isAuthenticated: true },
      queryClient: new StubSettingsClient(answer),
    },
    location: { href },
  });
}

/**
 * A thrown `redirect` is a `Response` carrying the navigation it describes on
 * `options`, so the destination is read from there rather than from the object
 * itself — which serializes as a bare 307 with none of the fields under test.
 */
function redirectOf(error: unknown): { to?: string; search?: { redirect?: string } } {
  return (error as { options?: { to?: string; search?: { redirect?: string } } }).options ?? {};
}

const COMPLETED = withOnboarding(DEFAULT_APP_SETTINGS, {
  ...DEFAULT_ONBOARDING_STATE,
  completedAt: 1,
});

describe('the first-run gate on the authenticated layout', () => {
  it('sends an unfinished account to setup, keeping where it was going', async () => {
    const error = await enter(DEFAULT_APP_SETTINGS).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(redirectOf(error).to).toBe('/welcome');
    expect(redirectOf(error).search?.redirect).toBe('/settings/general');
  });

  it('lets a finished account through untouched', async () => {
    await expect(enter(COMPLETED)).resolves.toBeUndefined();
  });

  it('does not guess completion when settings cannot be read', async () => {
    const failure = new Error('rate limited');

    // The refusal reaches the route's error boundary, which offers a retry.
    // Treating it as "not set up" would restart a wizard someone finished, and
    // treating it as "set up" would hide the one page that fixes the failure.
    const error = await enter(failure).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBe(failure);
  });

  it('preserves a destination that carries a query string', async () => {
    const error = await enter(DEFAULT_APP_SETTINGS, '/environments?tab=agents').then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(redirectOf(error).search?.redirect).toBe('/environments?tab=agents');
  });
});
