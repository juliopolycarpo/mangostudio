/**
 * Qualifies the compiled Rust runtime's external-agent admission against the
 * real hub code: its hello and health attestation, the hub's cross-environment
 * collision check, a hub's withdrawal, and the session methods' fail-closed
 * workspace authority, all over a real stdio child.
 *
 * The claim the collision check depends on is byte identity. A spawned runtime
 * attests `os-account` (or `container`) and the in-process Local connector
 * attests `single-user-host`, but both digest the same credential-home identity
 * with no method prefix. So one OS account reached through Local by one user
 * and through a Rust stdio runtime by another produces one fingerprint, and
 * the hub refuses both. A Rust derivation that differed by a single byte would
 * let the second user through, silently.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizedEnv, spawnPort } from '@mangostudio/protocol/spawn';
import { createExternalIdentityIsolationRegistry } from '../../../src/modules/external-agents/application/external-identity-isolation';
import { connectLocalRuntime } from '../../../src/services/runtime-client/connect-in-process-runtime';
import { openHubSession } from '../../../src/services/runtime-client/hub-session';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();

describe('Real Rust runtime external-agent admission', () => {
  let runtimeVersion: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    if (!binary.available) return;
    runtimeVersion = await rustRuntimeVersion(binary.path);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A stdio Rust runtime under a scratch MANGO_HOME, with `env` over the sanitized parent. */
  async function spawnRustRuntime(
    name: string,
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly externalAgentIsolation?: 'single-user' | 'withdrawn';
    } = {}
  ): Promise<RuntimeClient> {
    const mangoHome = await scratchMangoHome(name);
    const peer = spawnPort({
      argv: [binary.path, '--stdio'],
      env: { ...sanitizedEnv(process.env, { MANGO_HOME: mangoHome }), ...options.env },
      terminateGraceMs: 2_000,
      killGraceMs: 2_000,
      exitGraceMs: 1_000,
    });
    const hub = await openHubSession(peer.port, {
      hubVersion: runtimeVersion,
      ...(options.externalAgentIsolation
        ? { externalAgentIsolation: options.externalAgentIsolation }
        : {}),
    });
    cleanups.push(async () => {
      hub.close();
      await peer.terminate();
      await cleanupMangoHome(mangoHome);
    });
    return new RuntimeClient(hub, () => undefined, name);
  }

  it.skipIf(!binary.available)(
    'attests the credential home Local attests, so the hub sees two users collide',
    async () => {
      const rust = await spawnRustRuntime('rust-external-agents-attest');
      const local = await connectLocalRuntime({
        authorizeWorkspace: () => false,
        externalAgentIsolation: 'single-user',
      });
      cleanups.push(() => local.close());
      const localClient = new RuntimeClient(local.hub, () => undefined, 'local');

      const rustAttestation = rust.manifest.identityIsolation;
      const localAttestation = localClient.manifest.identityIsolation;
      expect(localAttestation?.method).toBe('single-user-host');
      expect(rustAttestation?.method).toMatch(/^(os-account|container)$/);
      // The whole point: one home, one digest, whichever route reached it.
      expect(rustAttestation?.credentialHomeFingerprint).toBe(
        localAttestation?.credentialHomeFingerprint
      );

      const health = await rust.health();
      expect(health.externalAgents).toMatchObject({
        targets: ['codex', 'cursor', 'claude'],
        liveSessionCount: 0,
        liveSessions: [],
        identityIsolation: rustAttestation,
      });

      const reaped: string[] = [];
      const registry = createExternalIdentityIsolationRegistry({
        sessions: {
          reapScope: (scope) => {
            reaped.push(scope.userId ?? '<no user>');
            return Promise.resolve();
          },
        },
      });
      expect(
        registry.resolve({ userId: 'user-a', environmentId: 'local', isolation: localAttestation })
      ).toEqual(localAttestation);
      expect(
        registry.resolve({ userId: 'user-b', environmentId: 'rust', isolation: rustAttestation })
      ).toBeUndefined();
      expect(registry.isContested(rustAttestation?.credentialHomeFingerprint ?? 'missing')).toBe(
        true
      );
      expect(reaped.sort()).toEqual(['user-a', 'user-b']);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'withholds the attestation from a hub that withdrew it',
    async () => {
      const rust = await spawnRustRuntime('rust-external-agents-withdrawn', {
        externalAgentIsolation: 'withdrawn',
      });
      expect(rust.manifest.identityIsolation).toBeUndefined();
      const health = await rust.health();
      expect(health.externalAgents?.identityIsolation).toBeUndefined();
      expect(health.externalAgents?.targets).toEqual(['codex', 'cursor', 'claude']);
    },
    30_000
  );

  it.skipIf(!binary.available)(
    'describes uninstalled targets and refuses every workspace through the real hub',
    async () => {
      // An empty PATH and a scratch HOME: no vendor CLI is reachable, so
      // discovery is deterministic and nothing real is launched.
      const home = await scratchMangoHome('rust-external-agents-home');
      cleanups.push(() => cleanupMangoHome(home));
      const emptyPath = join(home, 'empty-path');
      await mkdir(emptyPath);
      const rust = await spawnRustRuntime('rust-external-agents-admission', {
        env: {
          HOME: home,
          USERPROFILE: home,
          PATH: emptyPath,
          XDG_CONFIG_HOME: join(home, '.config'),
        },
      });
      // Five of the ten methods are implemented: the capability stays off.
      expect(rust.manifest.features.externalAgents).not.toBe(true);

      const discovered = await rust.externalAgents.discover({
        targetIds: ['codex', 'cursor', 'claude'],
        timeoutMs: 20_000,
      });
      expect(
        discovered.descriptors.map((descriptor) => [
          descriptor.targetId,
          descriptor.installed,
          descriptor.unavailableReason,
        ])
      ).toEqual([
        ['codex', false, 'not-installed'],
        ['cursor', false, 'not-installed'],
        ['claude', false, 'not-installed'],
      ]);

      await mkdir(join(home, 'workspace'));
      // Canonical, so the refusal can only be the authority's.
      const workspace = await realpath(join(home, 'workspace'));
      await expect(
        rust.externalAgents.open({
          sessionId: 'qualification-session',
          targetId: 'codex',
          workspacePath: workspace,
          configuration: { level: 'default', routing: 'user', workspaceRoots: [] },
          resumeMode: 'fallback',
          timeoutMs: 10_000,
        })
      ).rejects.toThrow(/is not authorized/);
      const health = await rust.health();
      expect(health.externalAgents?.liveSessionCount).toBe(0);
    },
    60_000
  );
});
