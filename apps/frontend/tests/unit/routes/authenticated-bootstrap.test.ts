/**
 * The authenticated layout's loader, against a hub that refuses one of the
 * shell's requests.
 *
 * Driven by calling the route's own `loader`, as the first-run gate's test
 * drives `beforeLoad`: what is under test is whether the loader resolves (the
 * shell renders and swaps its page for the bootstrap panel), throws a
 * redirect (the auth boundary), or throws anything else (the whole surface is
 * replaced) — and how many requests each outcome costs.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { catalogQueryOptions } from '../../../src/hooks/use-model-catalog';
import { Route as AuthenticatedRoute } from '../../../src/routes/_authenticated';
import {
  createShellBootstrapHub,
  FIRST_CHAT_MESSAGES_PATH,
  type ShellBootstrapHub,
  type ShellRefusal,
} from '../../support/mocks/shell-bootstrap-scenario';

interface LoaderContext {
  readonly context: { readonly queryClient: QueryClient };
  readonly location: { readonly href: string };
}

type Loader = (ctx: LoaderContext) => Promise<void>;

function loaderOf(route: unknown): Loader {
  return (route as { options: { loader: Loader } }).options.loader;
}

let hub: ShellBootstrapHub | undefined;

afterEach(() => {
  hub?.restore();
  hub = undefined;
});

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Runs the loader and reports how it left: resolved, or with what it threw. */
async function runLoader(
  queryClient: QueryClient,
  href = '/settings/general'
): Promise<{ resolved: true } | { resolved: false; thrown: unknown }> {
  try {
    await loaderOf(AuthenticatedRoute)({ context: { queryClient }, location: { href } });
    return { resolved: true };
  } catch (thrown) {
    return { resolved: false, thrown };
  }
}

function describeOutcome(outcome: Awaited<ReturnType<typeof runLoader>>): string {
  if (outcome.resolved) return 'resolved';
  const thrown = outcome.thrown;
  return `threw ${thrown instanceof Error ? thrown.message : JSON.stringify(thrown)}`;
}

/** A thrown `redirect` carries its navigation on `options`. */
function redirectOf(thrown: unknown): { to?: string; search?: { redirect?: string } } {
  return (thrown as { options?: { to?: string; search?: { redirect?: string } } }).options ?? {};
}

describe('the authenticated loader over a refused shell request', () => {
  const refusals: readonly [string, 'chats' | 'catalog' | 'agents', ShellRefusal][] = [
    ['a server error on the catalog', 'catalog', 'server-error'],
    ['a rate limit on agent settings', 'agents', 'rate-limited'],
    ['a dropped connection on the chat list', 'chats', 'network'],
  ];

  for (const [name, responsibility, refusal] of refusals) {
    it(`keeps the shell through ${name}`, async () => {
      hub = createShellBootstrapHub().refuse(responsibility, refusal).install();

      const outcome = await runLoader(newQueryClient());

      // Resolving is what keeps the shell: a throw here reaches the route's
      // boundary, which replaces navigation along with the page.
      expect(
        outcome.resolved,
        `expected loader outcome: resolved | received: ${describeOutcome(outcome)}`
      ).toBe(true);
    });
  }

  it('leaves the refusal in the cache for the layout to show', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'server-error').install();
    const queryClient = newQueryClient();

    await runLoader(queryClient);

    const state = queryClient.getQueryState(catalogQueryOptions().queryKey);
    expect(state?.status).toBe('error');
    expect(state?.data).toBeUndefined();
  });

  it('still starts the first transcript when only the catalog failed', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'server-error').install();

    await runLoader(newQueryClient());

    const transcripts = hub.requestCount(FIRST_CHAT_MESSAGES_PATH);
    expect(
      transcripts,
      `expected first-transcript requests with a refused catalog: 1 | received: ${transcripts}`
    ).toBe(1);
  });

  it('does not re-ask for a refused request when the router re-runs it', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'rate-limited').install();
    const queryClient = newQueryClient();

    // A navigation, then an intent preload: each re-runs a stale loader.
    await runLoader(queryClient, '/');
    await runLoader(queryClient, '/settings/general');
    await runLoader(queryClient, '/gallery');

    expect(
      hub.requestCount('catalog'),
      `expected catalog requests across three loader runs: 1 | received: ${hub.requestCount('catalog')}`
    ).toBe(1);
  });

  it('sends a rejected session to sign in, keeping where it was going', async () => {
    hub = createShellBootstrapHub().refuse('chats', 'unauthorized').install();

    const outcome = await runLoader(newQueryClient(), '/environments?tab=agents');

    expect(outcome.resolved, 'expected the loader to leave through the auth boundary').toBe(false);
    const thrown = outcome.resolved ? undefined : outcome.thrown;
    expect(
      redirectOf(thrown).to,
      `expected a rejected session to redirect to: /login | received: ${String(redirectOf(thrown).to ?? thrown)}`
    ).toBe('/login');
    expect(redirectOf(thrown).search?.redirect).toBe('/environments?tab=agents');
  });
});
