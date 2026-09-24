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
import { cancelActiveTurn } from '../../../src/modules/generation/application/active-turn-registry';
import { openHubSession } from '../../../src/services/runtime-client/hub-session';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  createRustTurnHarness,
  grantRuntimeConsent,
  type RustTurnHarness,
  turnPartOf,
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

  /** A signed-in vendor behind the compiled runtime, with a chat in an empty workspace. */
  async function liveSession(targetId: ExternalAgentTargetId) {
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

    const credentialHomeFingerprint = client.manifest.identityIsolation?.credentialHomeFingerprint;
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
    return { turns, owner, chatId };
  }

  /** Runs a one-word turn and returns its persisted `external_turn` part. */
  async function pongTurn(turns: RustTurnHarness, targetId: ExternalAgentTargetId, chatId: string) {
    const result = await within(
      turns.start(
        'Reply with exactly the single word pong and nothing else. Do not use any tools.'
      ),
      `the live ${targetId} turn`,
      170_000
    );
    // A one-word turn can finish before a poll sees it running: read the
    // chat's newest assistant message once it has settled.
    const latest = await getDb()
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chatId)
      .where('role', '=', 'ai')
      .orderBy('timestamp', 'desc')
      .executeTakeFirstOrThrow();
    const row = await turns.assistantRow(latest.id);
    if (result.reason !== 'completed') {
      throw new Error(
        `expected the live ${targetId} turn to complete | received: ${result.reason} ${JSON.stringify(result.error ?? null)}`
      );
    }
    expect(row.text.toLowerCase()).toContain('pong');
    return turnPartOf(row.parts);
  }

  for (const targetId of EXTERNAL_AGENT_TARGET_IDS) {
    it.skipIf(!binary.available || !requested.includes(targetId))(
      `${targetId}: discovers, opens and completes a one-word turn`,
      async () => {
        const { turns, chatId } = await liveSession(targetId);
        await pongTurn(turns, targetId, chatId);
        await turns.close();
      },
      180_000
    );
  }

  // Claude has no protocol cancel: a Claude cancel is a forced, nonresumable
  // stop on Windows, which the fixture qualification and runtime tests cover.
  for (const targetId of ['codex', 'cursor'] as const) {
    it.skipIf(!binary.available || !requested.includes(targetId))(
      `${targetId}: cancels a streaming turn and completes the next one on the same session`,
      async () => {
        const { turns, owner, chatId } = await liveSession(targetId);
        const running = turns.start(
          'Count from 1 to 300, one number per line, and nothing else. Do not use any tools.'
        );
        const messageId = await runningMessageId(turns);
        await streamingStarted(turns, messageId);
        expect(cancelActiveTurn(messageId, owner.id, chatId, 'user_cancelled')).toBe(true);
        const cancelled = await within(running, `the cancelled live ${targetId} turn`, 120_000);
        expect(cancelled.reason).toBe('cancelled-by-user');
        const cancelledTurn = turnPartOf((await turns.assistantRow(messageId)).parts);

        const next = await pongTurn(turns, targetId, chatId);
        expect(next.sessionId).toBe(cancelledTurn.sessionId);
        await turns.close();
      },
      360_000
    );
  }
});

/** The assistant message a just-started turn is writing, once the hub has created it. */
async function runningMessageId(turns: RustTurnHarness): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      return await turns.runningAssistantMessageId();
    } catch (error) {
      last = error;
      await Bun.sleep(25);
    }
  }
  throw new Error(`expected the turn to create its assistant message | received: ${String(last)}`);
}

/** Resolves once the vendor has streamed some text into `messageId`. */
async function streamingStarted(turns: RustTurnHarness, messageId: string): Promise<void> {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    if ((await turns.assistantRow(messageId)).text.length > 0) return;
    await Bun.sleep(100);
  }
  throw new Error('expected the vendor to stream text within 120 s | received: no text');
}
