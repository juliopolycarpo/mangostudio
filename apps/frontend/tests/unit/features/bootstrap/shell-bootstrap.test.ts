/**
 * Settling the authenticated shell's data one responsibility at a time.
 *
 * What matters is what leaves each function: data or a failure, never a
 * throw, and a request count that does not grow when the router re-runs a
 * loader over a failure the bootstrap panel already owns.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { QueryClient } from '@tanstack/react-query';
import {
  isAuthFailure,
  isRateLimited,
  loadShellBootstrap,
  refetchShellResponsibility,
  settleShellQuery,
} from '../../../../src/features/bootstrap/shell-bootstrap';
import { chatListQueryOptions } from '../../../../src/features/chat/queries';
import { catalogQueryOptions } from '../../../../src/hooks/use-model-catalog';
import { ApiError } from '../../../../src/lib/utils';
import {
  createShellBootstrapHub,
  type ShellBootstrapHub,
} from '../../../support/mocks/shell-bootstrap-scenario';

let hub: ShellBootstrapHub | undefined;

afterEach(() => {
  hub?.restore();
  hub = undefined;
});

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('isAuthFailure', () => {
  it('recognizes a rejected session and nothing else', () => {
    expect(isAuthFailure(new ApiError({ error: 'no', code: ERROR_CODES.UNAUTHORIZED }))).toBe(true);
    expect(isAuthFailure(new ApiError({ error: 'slow', code: ERROR_CODES.RATE_LIMITED }))).toBe(
      false
    );
    expect(isAuthFailure(new TypeError('Failed to fetch'))).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });
});

describe('isRateLimited', () => {
  it('recognizes the hub rate limit and nothing else', () => {
    expect(isRateLimited(new ApiError({ error: 'slow', code: ERROR_CODES.RATE_LIMITED }))).toBe(
      true
    );
    expect(isRateLimited(new ApiError({ error: 'no', code: ERROR_CODES.UNAUTHORIZED }))).toBe(
      false
    );
    expect(isRateLimited(new TypeError('Failed to fetch'))).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});

describe('settleShellQuery', () => {
  it('hands back the data when the request succeeds', async () => {
    hub = createShellBootstrapHub().install();

    const settled = await settleShellQuery(newQueryClient(), chatListQueryOptions());

    expect(settled.ok).toBe(true);
  });

  it('hands back a refusal instead of throwing it', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'server-error').install();

    const settled = await settleShellQuery(newQueryClient(), catalogQueryOptions());

    expect(settled.ok, 'expected a refused catalog to settle as ok: false').toBe(false);
    expect(settled.ok ? null : settled.error).toBeInstanceOf(ApiError);
  });

  it('does not ask again for a responsibility that already failed', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'rate-limited').install();
    const queryClient = newQueryClient();

    await settleShellQuery(queryClient, catalogQueryOptions());
    const again = await settleShellQuery(queryClient, catalogQueryOptions());

    // The router re-runs this on every navigation and intent preload; the
    // bootstrap panel's retry is what asks again.
    expect(
      hub.requestCount('catalog'),
      `expected catalog requests after a second settle: 1 | received: ${hub.requestCount('catalog')}`
    ).toBe(1);
    expect(again.ok ? null : (again.error as ApiError).code).toBe(ERROR_CODES.RATE_LIMITED);
  });

  it('asks again after an authentication failure, so a new session does not inherit it', async () => {
    hub = createShellBootstrapHub().refuse('chats', 'unauthorized').install();
    const queryClient = newQueryClient();

    await settleShellQuery(queryClient, chatListQueryOptions());
    hub.answer('chats');
    const again = await settleShellQuery(queryClient, chatListQueryOptions());

    expect(hub.requestCount('chats')).toBe(2);
    expect(again.ok, 'expected the chat list after signing in again to load').toBe(true);
  });
});

describe('loadShellBootstrap', () => {
  it('loads every responsibility and returns the chat list', async () => {
    hub = createShellBootstrapHub().install();

    const outcome = await loadShellBootstrap(newQueryClient());

    expect(outcome.chats?.map((chat) => chat.id)).toEqual(['chat-1']);
    expect(outcome.authFailure).toBeUndefined();
  });

  it('keeps going past a dropped connection, leaving the others loaded', async () => {
    hub = createShellBootstrapHub().refuse('chats', 'network').install();
    const queryClient = newQueryClient();

    const outcome = await loadShellBootstrap(queryClient);

    expect(outcome.chats).toBeUndefined();
    expect(outcome.authFailure).toBeUndefined();
    expect(queryClient.getQueryState(catalogQueryOptions().queryKey)?.status).toBe('success');
  });

  it('reports an authentication failure for the caller to redirect on', async () => {
    hub = createShellBootstrapHub().refuse('agents', 'unauthorized').install();

    const outcome = await loadShellBootstrap(newQueryClient());

    expect(isAuthFailure(outcome.authFailure)).toBe(true);
  });
});

describe('refetchShellResponsibility', () => {
  it('asks again for exactly the responsibility named', async () => {
    hub = createShellBootstrapHub().refuse('catalog', 'server-error').install();
    const queryClient = newQueryClient();
    await loadShellBootstrap(queryClient);
    hub.answer('catalog');

    await refetchShellResponsibility(queryClient, 'catalog');

    expect(hub.requestCount('catalog')).toBe(2);
    expect(hub.requestCount('chats')).toBe(1);
    expect(hub.requestCount('agents')).toBe(1);
    expect(queryClient.getQueryState(catalogQueryOptions().queryKey)?.status).toBe('success');
  });
});
