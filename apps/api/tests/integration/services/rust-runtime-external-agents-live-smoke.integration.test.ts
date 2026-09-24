/**
 * Authenticated smoke: the compiled Rust runtime hosting the real, signed-in
 * vendor CLIs on this machine, driven by the hub's own turn controller.
 *
 * Opt-in and never part of CI. It reaches real vendor accounts, so it runs
 * only when `MANGOSTUDIO_LIVE_AGENT_SMOKE` names the targets to try, e.g.
 * `MANGOSTUDIO_LIVE_AGENT_SMOKE=claude,codex,cursor`. Each turn asks for one
 * word in an empty scratch workspace and answers no approval, so a tool the
 * vendor wants to run is never granted and nothing on the machine changes. Fixture evidence lives in
 * `rust-runtime-external-agents-qualification.integration.test.ts`; this file
 * is the separate, labelled live evidence.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizedEnv, spawnPort } from '@mangostudio/protocol/spawn';
import {
  EXTERNAL_AGENT_TARGET_IDS,
  type ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import { getDb } from '../../../src/db/database';
import { openHubSession } from '../../../src/services/runtime-client/hub-session';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  createRustTurnHarness,
  grantRuntimeConsent,
  within,
} from '../../support/external-agents/rust-agent-turns';
import { insertTestUser } from '../../support/factories';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  rustRuntimeVersion,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';

const binary = resolveRustRuntimeBinary();
const requested = (process.env.MANGOSTUDIO_LIVE_AGENT_SMOKE ?? '')
  .split(',')
  .map((target) => target.trim())
  .filter((target): target is ExternalAgentTargetId =>
    (EXTERNAL_AGENT_TARGET_IDS as readonly string[]).includes(target)
  );

describe('Authenticated smoke: real vendor CLIs through the Rust runtime', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  for (const targetId of EXTERNAL_AGENT_TARGET_IDS) {
    it.skipIf(!binary.available || !requested.includes(targetId))(
      `${targetId}: discovers, opens and completes a one-word turn`,
      async () => {
        const scratch = await realpath(await scratchMangoHome(`live-smoke-${targetId}`));
        cleanups.push(() => cleanupMangoHome(scratch));
        await mkdir(join(scratch, 'workspace'));
        const workspace = join(scratch, 'workspace');
        const environmentId = `live-smoke-${targetId}`;
        const owner = await insertTestUser();
        const chatId = `chat-${crypto.randomUUID()}`;
        await getDb()
          .insertInto('chats')
          .values({
            id: chatId,
            title: 'live smoke',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model: null,
            userId: owner.id,
            runnerKind: 'external',
            runnerTargetId: targetId,
            workdir: workspace,
            environmentId,
          })
          .execute();
        cleanups.push(async () => {
          await getDb().deleteFrom('messages').where('chatId', '=', chatId).execute();
          await getDb().deleteFrom('chats').where('id', '=', chatId).execute();
          await getDb().deleteFrom('user').where('id', '=', owner.id).execute();
        });

        const mangoHome = join(scratch, 'mango');
        await mkdir(mangoHome);
        await grantRuntimeConsent(binary.path, mangoHome, 'host');
        // The real HOME and PATH: the signed-in CLIs are the point.
        const peer = spawnPort({
          argv: [binary.path, '--stdio'],
          env: sanitizedEnv(process.env, { MANGO_HOME: mangoHome }),
          terminateGraceMs: 2_000,
          killGraceMs: 2_000,
          exitGraceMs: 1_000,
        });
        const hub = await openHubSession(peer.port, {
          workspaceBinding: { userId: owner.id, environmentId },
          hubVersion: await rustRuntimeVersion(binary.path),
        });
        cleanups.push(async () => {
          hub.close();
          await peer.terminate();
        });
        const client = new RuntimeClient(hub, () => undefined, environmentId);

        const [descriptor] = (
          await client.externalAgents.discover({ targetIds: [targetId], timeoutMs: 60_000 })
        ).descriptors;
        expect(descriptor).toMatchObject({ targetId, installed: true });

        const credentialHomeFingerprint =
          client.manifest.identityIsolation?.credentialHomeFingerprint;
        if (!credentialHomeFingerprint) {
          throw new Error(
            `expected the runtime to attest a credential home | received: ${JSON.stringify(client.manifest.identityIsolation)}`
          );
        }
        const turns = createRustTurnHarness({
          client,
          userId: owner.id,
          chatId,
          workspace,
          credentialHomeFingerprint,
        });
        const running = turns.start(
          'Reply with exactly the single word pong and nothing else. Do not use any tools.'
        );
        const result = await within(running, `the live ${targetId} turn`, 170_000);
        const messageId = (
          await getDb()
            .selectFrom('messages')
            .select('id')
            .where('chatId', '=', chatId)
            .where('role', '=', 'ai')
            .executeTakeFirstOrThrow()
        ).id;
        const row = await turns.assistantRow(messageId);
        expect(result.reason).toBe('completed');
        expect(row.text.toLowerCase()).toContain('pong');
        await turns.close();
      },
      180_000
    );
  }
});
