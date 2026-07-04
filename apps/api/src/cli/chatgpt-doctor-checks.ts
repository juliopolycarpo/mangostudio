/**
 * ChatGPT connector diagnostics for the `doctor` command. OAuth connectors
 * fail in ways API-key connectors don't — expired or revoked refresh tokens,
 * an unreachable OS secret store, another process squatting the fixed OAuth
 * callback port, an unreachable backend — and each gets its own checklist row
 * so "ChatGPT stopped working" becomes a copy-pasteable diagnosis.
 *
 * Never mutates user data by default: the live refresh probe (which rotates
 * the stored refresh token) only runs behind the explicit `--chatgpt-refresh`
 * flag. The storage check writes and deletes a throwaway probe secret so
 * write-path failures (e.g. the Windows credential blob size limit) surface
 * here instead of only during sign-in.
 */

import { createServer } from 'node:net';
import type { SecretMetadataRow } from '@mangostudio/shared/types';
import type { MangoConfig } from '../lib/config';
import {
  CHATGPT_REAUTH_REQUIRED_CODE,
  type ChatGptTokenBundle,
} from '../modules/connectors/infrastructure/chatgpt/oauth-client';
import { CHATGPT_OAUTH_CALLBACK_PORT } from '../modules/connectors/infrastructure/chatgpt/oauth-constants';
import { createChatGptTokenService } from '../modules/connectors/infrastructure/chatgpt/token-service';
import {
  type FetchLike,
  OAuthReauthRequiredError,
} from '../modules/connectors/infrastructure/oauth/token-client';
import {
  PROVIDER_PROBE_TIMEOUT_MS,
  withAbortTimeout,
  withPromiseTimeout,
} from '../services/providers/core/probe-timeout';
import { bunSecretStore, type SecretStore } from '../services/secret-store/store';
import { maskSecret } from '../utils/secrets';
import { type CheckResult, fail, ok, warn } from './doctor-checks';

/** Injectable seams so every check runs against fakes in tests. */
export interface ChatGptDoctorDeps {
  secretStore: SecretStore;
  readBundle(connector: SecretMetadataRow): Promise<ChatGptTokenBundle>;
  /** Live refresh probe — mutating: rotates and persists the refresh token. */
  refreshTokens(connector: SecretMetadataRow): Promise<ChatGptTokenBundle>;
  isPortFree(port: number): Promise<boolean>;
  fetchImpl: FetchLike;
  now(): number;
  timeoutMs: number;
}

export function createChatGptDoctorDeps(): ChatGptDoctorDeps {
  const tokenService = createChatGptTokenService();
  return {
    secretStore: bunSecretStore,
    readBundle: (connector) => tokenService.readBundle(connector.id),
    refreshTokens: (connector) => tokenService.forceRefreshTokens(connector),
    isPortFree: probeLoopbackPortFree,
    fetchImpl: fetch,
    now: () => Date.now(),
    timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
  };
}

/**
 * Runs the ChatGPT doctor section: secret storage, per-connector token state
 * (plus the opt-in refresh probe), the fixed callback port, and backend
 * reachability. Never prints token material; accounts are masked like the
 * connector card.
 */
export async function collectChatGptDoctorChecks(
  config: MangoConfig,
  connectors: readonly SecretMetadataRow[],
  refresh: boolean,
  deps: ChatGptDoctorDeps = createChatGptDoctorDeps()
): Promise<CheckResult[]> {
  const results: CheckResult[] = [await checkSecretStorage(deps.secretStore)];

  for (const connector of connectors) {
    const { result, bundle } = await checkTokenState(connector, deps);
    results.push(result);
    if (refresh) {
      results.push(await probeRefresh(connector, bundle, deps));
    }
  }

  results.push(await checkCallbackPort(deps));
  results.push(await probeEndpoint('ChatGPT auth', config.chatgpt.authBaseUrl, deps));
  results.push(await probeEndpoint('ChatGPT backend', config.chatgpt.apiBaseUrl, deps));
  return results;
}

/** Sized like a persisted OAuth token bundle (three JWTs), not an API key. */
const SECRET_PROBE_BYTES = 8192;
const SECRET_PROBE_DESCRIPTOR = { service: 'mangostudio', name: '__doctor-write-probe__' };

async function checkSecretStorage(secretStore: SecretStore): Promise<CheckResult> {
  const label = 'ChatGPT secrets';
  if (!(await secretStore.isAvailable())) {
    return fail(label, 'secret store unavailable — stored ChatGPT tokens cannot be read');
  }

  try {
    const payload = 'm'.repeat(SECRET_PROBE_BYTES);
    await secretStore.setSecret(SECRET_PROBE_DESCRIPTOR, payload);
    const readBack = await secretStore.getSecret(SECRET_PROBE_DESCRIPTOR);
    if (readBack !== payload) {
      return fail(label, 'secret store returned corrupted data for a token-sized write');
    }
    return ok(label, 'secret store reachable (token-sized write verified)');
  } catch (error) {
    return fail(label, `token-sized write failed — ${errorMessage(error)}`);
  } finally {
    await secretStore.deleteSecret(SECRET_PROBE_DESCRIPTOR).catch(() => {
      // Best-effort cleanup; a leftover probe entry is harmless.
    });
  }
}

interface TokenStateResult {
  result: CheckResult;
  bundle: ChatGptTokenBundle | null;
}

async function checkTokenState(
  connector: SecretMetadataRow,
  deps: ChatGptDoctorDeps
): Promise<TokenStateResult> {
  const label = 'ChatGPT tokens';
  let bundle: ChatGptTokenBundle;
  try {
    bundle = await deps.readBundle(connector);
  } catch (error) {
    return { result: fail(label, `${connector.name}: ${errorMessage(error)}`), bundle: null };
  }

  const account = describeAccount(bundle, connector);
  if (connector.lastValidationError === CHATGPT_REAUTH_REQUIRED_CODE) {
    return {
      result: fail(label, `${account} — session expired; sign in with ChatGPT again`),
      bundle,
    };
  }

  const remainingMs = bundle.expiresAt - deps.now();
  if (remainingMs <= 0) {
    return {
      result: warn(
        label,
        `${account} — access token expired ${formatDuration(-remainingMs)} ago (refreshes on next use)`
      ),
      bundle,
    };
  }
  return {
    result: ok(label, `${account} — access token expires in ${formatDuration(remainingMs)}`),
    bundle,
  };
}

async function probeRefresh(
  connector: SecretMetadataRow,
  bundle: ChatGptTokenBundle | null,
  deps: ChatGptDoctorDeps
): Promise<CheckResult> {
  const label = 'ChatGPT refresh';
  if (!bundle) {
    return fail(label, `${connector.name}: skipped — no readable token bundle`);
  }

  try {
    const rotated = await withPromiseTimeout(
      () => deps.refreshTokens(connector),
      `refresh probe timed out after ${deps.timeoutMs}ms`,
      deps.timeoutMs
    );
    const remaining = formatDuration(rotated.expiresAt - deps.now());
    return ok(
      label,
      `${describeAccount(rotated, connector)} — refresh token rotated; new access token expires in ${remaining}`
    );
  } catch (error) {
    if (error instanceof OAuthReauthRequiredError) {
      return fail(
        label,
        `${connector.name}: refresh rejected (invalid_grant) — sign in with ChatGPT again`
      );
    }
    return fail(label, `${connector.name}: ${errorMessage(error)}`);
  }
}

async function checkCallbackPort(deps: ChatGptDoctorDeps): Promise<CheckResult> {
  const label = 'ChatGPT port';
  return (await deps.isPortFree(CHATGPT_OAUTH_CALLBACK_PORT))
    ? ok(label, `${CHATGPT_OAUTH_CALLBACK_PORT} free (OAuth sign-in callback)`)
    : warn(
        label,
        `${CHATGPT_OAUTH_CALLBACK_PORT} in use — new ChatGPT sign-ins will fail until it is released (Codex CLI uses the same port)`
      );
}

async function probeEndpoint(
  label: string,
  baseUrl: string,
  deps: ChatGptDoctorDeps
): Promise<CheckResult> {
  try {
    const response = await withAbortTimeout(
      (signal) => deps.fetchImpl(baseUrl, { method: 'HEAD', redirect: 'manual', signal }),
      `timed out after ${deps.timeoutMs}ms`,
      deps.timeoutMs
    );
    return ok(label, `${baseUrl} (HTTP ${response.status})`);
  } catch (error) {
    return fail(label, `${baseUrl} (${errorMessage(error)})`);
  }
}

/** Masked account identity, matching the Settings connector card. */
function describeAccount(bundle: ChatGptTokenBundle, connector: SecretMetadataRow): string {
  const masked = maskSecret(bundle.email ?? bundle.accountId) ?? connector.name;
  return bundle.planType ? `${masked} (${bundle.planType})` : masked;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${Math.round(totalHours / 24)}d`;
}

/** Whether the fixed loopback callback port can be bound right now. */
export function probeLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}
