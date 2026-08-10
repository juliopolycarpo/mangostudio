/**
 * Who Claude thinks is signed in — reduced to the least that is useful.
 *
 * `claude auth status` is structured and authoritative, and it returns **more
 * personal data than any other vendor's status call**:
 *
 * ```json
 * { "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
 *   "email": "…", "orgId": "…", "orgName": "…", "subscriptionType": "pro" }
 * ```
 *
 * Three of those fields never leave this process. `email`, `orgId` and
 * `orgName` are not needed to render a selector, to decide a permission mode or
 * to notice that the account changed, and a diagnostic that carried an
 * organization name would put a customer's identity in a log that outlives the
 * session. What crosses instead is a label the owner recognizes, a coarse
 * account kind, and a keyed digest whose only job is to invalidate continuation.
 *
 * The `accountKind` is load-bearing twice over, which is why it is derived here
 * rather than inferred downstream: the account-sharing clause in Anthropic's
 * Consumer Terms bites on subscription-backed accounts specifically, so both the
 * isolation refusal copy and the third-party disclosure need to know which one
 * is in play — without either of them learning who the account belongs to.
 */

import { createHmac } from 'node:crypto';
import type {
  ExternalAgentAccount,
  ExternalAgentAuthState,
} from '@mangostudio/shared/external-agents';
import { hostLocalDigestKey } from '../isolation';

/**
 * How the account is paid for, coarsely.
 *
 * Three buckets, because three is what any consumer of this needs to
 * distinguish. A finer split would start encoding plan tiers, which change on
 * the vendor's schedule and are not MangoStudio's to track.
 */
export type ClaudeAccountKind = 'subscription' | 'api-key' | 'cloud-provider';

/** The `auth status` payload, narrowed to the fields this adapter reads. */
interface ClaudeAuthStatus {
  readonly loggedIn?: unknown;
  readonly authMethod?: unknown;
  readonly apiProvider?: unknown;
  readonly email?: unknown;
  readonly subscriptionType?: unknown;
}

export interface ClaudeAuthentication {
  readonly authState: ExternalAgentAuthState;
  /** Absent when the status call did not establish a signed-in account. */
  readonly accountKind?: ClaudeAccountKind;
  readonly account?: ExternalAgentAccount;
}

/** What an invocation that produced nothing usable reads as. */
export const CLAUDE_AUTH_UNKNOWN: ClaudeAuthentication = { authState: 'unknown' };

/**
 * `apiProvider` mapped onto the coarse kind.
 *
 * `firstParty` is Anthropic billing the account directly, which covers both a
 * subscription and a raw API key — `authMethod` is what separates them.
 * Anything naming a hyperscaler is a cloud provider's credentials rather than
 * an Anthropic account, and the sharing clause reads differently there because
 * the seat being shared is not Anthropic's to police.
 */
function accountKindFrom(status: ClaudeAuthStatus): ClaudeAccountKind {
  const provider = typeof status.apiProvider === 'string' ? status.apiProvider.toLowerCase() : '';
  if (provider.includes('bedrock') || provider.includes('vertex') || provider.includes('foundry')) {
    return 'cloud-provider';
  }
  const method = typeof status.authMethod === 'string' ? status.authMethod.toLowerCase() : '';
  // `claude.ai` is the OAuth sign-in behind Pro, Max and Team. An API key
  // authenticates the same first-party service without a seat behind it.
  return method.includes('claude.ai') || method.includes('oauth') ? 'subscription' : 'api-key';
}

/** A label the owner recognizes. Never the email, and never the organization. */
function labelFor(kind: ClaudeAccountKind): string {
  switch (kind) {
    case 'subscription':
      return 'Claude account';
    case 'api-key':
      return 'Anthropic API key';
    case 'cloud-provider':
      return 'Cloud provider credentials';
  }
}

/**
 * Keyed, because an email is not enough entropy to hash.
 *
 * A plain `sha256(email)` crossing to the hub is not an opaque identifier — it
 * is something anyone holding it can test a guessed address against offline,
 * which recovers exactly the personal data leaving the address behind was meant
 * to protect. An HMAC under a key that never leaves this machine keeps the
 * value stable and comparable while making it meaningless to anyone who did not
 * compute it.
 *
 * No key, no fingerprint. Falling back to an unkeyed digest would ship the
 * weaker thing under the stronger name, and the field is optional precisely so
 * that omitting it is available.
 */
function fingerprintAccount(email: string): string | undefined {
  const key = hostLocalDigestKey();
  if (!key) return undefined;
  return createHmac('sha256', key).update(`claude:${email}`).digest('hex').slice(0, 32);
}

/**
 * Reads one `claude auth status` payload.
 *
 * A payload that is not an object, or whose `loggedIn` is not a boolean, is
 * `unknown` rather than signed-out: the scanner already treats a missing
 * credentials file as unknown because Claude may use the system keychain, and
 * an unreadable status call is the same class of ignorance. Only an explicit
 * `loggedIn: false` is a signed-out verdict.
 */
function readClaudeAuthentication(payload: unknown): ClaudeAuthentication {
  if (typeof payload !== 'object' || payload === null) return CLAUDE_AUTH_UNKNOWN;
  const status = payload as ClaudeAuthStatus;
  if (status.loggedIn === false) return { authState: 'signed-out' };
  if (status.loggedIn !== true) return CLAUDE_AUTH_UNKNOWN;

  const accountKind = accountKindFrom(status);
  const fingerprint =
    typeof status.email === 'string' && status.email.length > 0
      ? fingerprintAccount(status.email)
      : undefined;
  const planType =
    typeof status.subscriptionType === 'string' && status.subscriptionType.length > 0
      ? status.subscriptionType
      : undefined;

  return {
    authState: 'signed-in',
    accountKind,
    account: {
      label: labelFor(accountKind),
      ...(planType ? { planType } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    },
  };
}

/**
 * Parses the JSON `claude auth status` writes to stdout.
 *
 * Tolerant of surrounding lines: the command prints one JSON object today, but
 * a build that prefixed a warning would otherwise turn a signed-in account into
 * `unknown`, which reads to the user as a broken install. Anything that is not
 * JSON at all still lands on `unknown`, which is the honest answer.
 */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthentication {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return CLAUDE_AUTH_UNKNOWN;
  try {
    return readClaudeAuthentication(JSON.parse(stdout.slice(start, end + 1)));
  } catch {
    return CLAUDE_AUTH_UNKNOWN;
  }
}
