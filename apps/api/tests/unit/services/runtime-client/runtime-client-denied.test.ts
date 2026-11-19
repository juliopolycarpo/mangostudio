/**
 * Which wire `DENIED` the hub rebuilds as a consent refusal.
 *
 * `DENIED` is the protocol's reserved "policy refuses this method", and consent is only one such
 * policy. Callers present `RuntimeConsentDeniedError` as "the machine owner turned this off" (a 403
 * "writes are turned off on this machine", a `runtime-denied` unavailable reason), so a refusal for
 * any other reason must not wear that error.
 *
 * The consent shapes below are the exact `err.error` bodies the runtime emits, not shapes the test
 * invents. Their Rust twin is `consent_denial_wire_shape_is_pinned_for_the_hub` in
 * `crates/mangostudio-runtime-core/src/ports/authorization.rs`; change one and the other fails.
 */
import { describe, expect, it } from 'bun:test';

import { RemoteError } from '@mangostudio/protocol';
import {
  CONSENT_DENIED_KIND,
  RuntimeConsentDeniedError,
  RuntimePolicyDeniedError,
} from '@mangostudio/shared/runtime-contract';

import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import { connectTestRuntime } from '../../../support/runtime-fixture';

interface WireError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/**
 * `consent_denial("shell.run", ["shell"], "host")`: what `AuthorizationGuard` answers, and what the
 * terminal, command, library, install, MCP and external-agent launch rechecks answer too, since all
 * of them build it through the same constructor.
 */
const RUST_CONSENT_DENIAL: WireError = {
  code: 'DENIED',
  message:
    '"shell.run" is refused: this machine has not granted shell. Run "mangostudio-runtime setup --slot host" there to change what a hub may do.',
  details: {
    kind: 'consent_denied',
    method: 'shell.run',
    missing: ['shell'],
    slot: 'host',
    capability: 'shell',
  },
};

const SHELL_PARAMS = {
  command: 'true',
  kind: 'bash',
  timeoutMs: 1_000,
  maxOutputBytes: 1024,
} as const;

/** Answers `shell.run` with `wire` verbatim and returns what the hub's client throws. */
async function thrownFor(wire: WireError): Promise<unknown> {
  function refuseShellRun(): never {
    throw new RemoteError(wire.code, wire.message, wire.details);
  }
  const runtime = await connectTestRuntime({ handlers: { 'shell.run': refuseShellRun } });
  try {
    const client = new RuntimeClient(runtime.hub);
    return await client.shell.run(SHELL_PARAMS).catch((error: unknown) => error);
  } finally {
    await runtime.close();
  }
}

describe('RuntimeClient DENIED translation', () => {
  it('pins the kind string the Rust constructor stamps on a consent refusal', () => {
    expect(RUST_CONSENT_DENIAL.details?.kind).toBe(CONSENT_DENIED_KIND);
  });

  it('rebuilds the Rust consent_denial shape as a consent refusal with its details', async () => {
    const error = await thrownFor(RUST_CONSENT_DENIAL);

    expect(error).toBeInstanceOf(RuntimeConsentDeniedError);
    expect((error as RuntimeConsentDeniedError).message).toBe(RUST_CONSENT_DENIAL.message);
    expect((error as RuntimeConsentDeniedError).details).toEqual({
      capability: 'shell',
      method: 'shell.run',
      slot: 'host',
      missing: ['shell'],
    });
  });

  it('keeps the kind alone sufficient: a consent refusal that names no capability list', async () => {
    // `consent_denial` leaves `capability` off when nothing is missing; the kind still says consent.
    const error = await thrownFor({
      code: 'DENIED',
      message: 'refused',
      details: { kind: 'consent_denied', method: 'mcp.connect', slot: 'host' },
    });

    expect(error).toBeInstanceOf(RuntimeConsentDeniedError);
  });

  it('treats a DENIED that carries only a missing capability list as consent', async () => {
    // No runtime has sent this shape: every DENIED, from the TypeScript runtime's `consentDenial`
    // through `consent_denial`, carries the kind. It is a fallback for a peer that drops the kind.
    const error = await thrownFor({
      code: 'DENIED',
      message: 'fsWrite was not granted',
      details: { missing: ['fsWrite'], capability: 'fsWrite' },
    });

    expect(error).toBeInstanceOf(RuntimeConsentDeniedError);
    expect((error as RuntimeConsentDeniedError).details).toMatchObject({
      capability: 'fsWrite',
      missing: ['fsWrite'],
    });
  });

  it('rebuilds an older peer INTERNAL + kind=consent_denied as a consent refusal', async () => {
    const error = await thrownFor({
      code: 'INTERNAL',
      message: '"shell.run" is refused',
      details: { kind: 'consent_denied', method: 'shell.run', capability: 'shell', slot: 'host' },
    });

    expect(error).toBeInstanceOf(RuntimeConsentDeniedError);
  });

  const nonConsentRefusals: readonly (readonly [string, WireError])[] = [
    [
      'a policy refusal with its own kind',
      {
        code: 'DENIED',
        message: 'gh pr merge is not an allowed argument shape.',
        details: { kind: 'gh_argument_policy', argument: 'pr merge' },
      },
    ],
    ['a refusal with no details', { code: 'DENIED', message: 'refused' }],
    ['a refusal with unrelated details', { code: 'DENIED', message: 'x', details: { path: '/a' } }],
    [
      'a refusal whose missing is not a list',
      { code: 'DENIED', message: 'x', details: { missing: 'shell' } },
    ],
  ];

  for (const [label, wire] of nonConsentRefusals) {
    it(`keeps ${label} out of the consent error`, async () => {
      const error = await thrownFor(wire);

      expect(error).not.toBeInstanceOf(RuntimeConsentDeniedError);
      expect(error).toBeInstanceOf(RuntimePolicyDeniedError);
      const refusal = error as RuntimePolicyDeniedError;
      expect(refusal.message).toBe(wire.message);
      expect(refusal.details).toEqual(wire.details ?? {});
      // The runtime's own answer stays reachable for a caller that walks `cause`.
      expect(refusal.cause).toBeInstanceOf(RemoteError);
      expect((refusal.cause as RemoteError).code).toBe('DENIED');
      expect((refusal.cause as RemoteError).details).toEqual(wire.details);
    });
  }
});
