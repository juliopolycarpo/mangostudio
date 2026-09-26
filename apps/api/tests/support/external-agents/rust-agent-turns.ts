/**
 * Runs real external-agent turns through the hub's own turn controller against
 * the compiled Rust runtime, with a stand-in vendor on its `PATH`.
 *
 * The vendor is `crates/mangostudio-runtime/examples/fake_cursor_agent.rs`: a
 * `cursor-agent` that pipes its stdio through the SDK's `FakeAcpAgent`. Every
 * turn streams `hello` and then asks one permission question, so a turn can be
 * completed by answering it, or cancelled while it waits.
 *
 * `MANGOSTUDIO_FAKE_CURSOR_AGENT` names the exact binary CI built, in the same
 * way `MANGOSTUDIO_RUNTIME_BINARY` names the runtime. Locally, this falls back to
 * `target/debug/examples/fake_cursor_agent`, which
 * `cargo build -p mangostudio-runtime --example fake_cursor_agent` produces.
 */

import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExternalAgentConfiguration } from '@mangostudio/shared/external-agents';
import type {
  ExternalApprovalPart,
  ExternalTurnPart,
  MessagePart,
} from '@mangostudio/shared/types';
import { getDb } from '../../../src/db/database';
import { createExternalApprovalRegistry } from '../../../src/modules/external-agents/application/external-approval-registry';
import { createExternalCommandCatalogCache } from '../../../src/modules/external-agents/application/external-command-catalog-cache';
import { createExternalSessionManager } from '../../../src/modules/external-agents/application/external-session-manager';
import {
  createExternalTurnController,
  type ExternalTurnResult,
} from '../../../src/modules/external-agents/application/external-turn-controller';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';

const executable = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

const FALLBACK_FAKE_CURSOR_AGENT = join(
  import.meta.dir,
  '../../../../../target/debug/examples',
  executable('fake_cursor_agent')
);

export interface FakeCursorAgent {
  readonly path: string;
  /** False only for the tolerant local-dev fallback; never for an explicit override. */
  readonly available: boolean;
}

/**
 * Resolves the stand-in vendor once per test file.
 *
 * @example
 * const fake = resolveFakeCursorAgent();
 * it.skipIf(!binary.available || !fake.available)('...', async () => { ... });
 */
export function resolveFakeCursorAgent(): FakeCursorAgent {
  const configured = process.env.MANGOSTUDIO_FAKE_CURSOR_AGENT?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(
        `MANGOSTUDIO_FAKE_CURSOR_AGENT is set to ${configured}, which does not exist. Build it ` +
          'first with "cargo build -p mangostudio-runtime --example fake_cursor_agent --locked".'
      );
    }
    return { path: configured, available: true };
  }
  return {
    path: FALLBACK_FAKE_CURSOR_AGENT,
    available: existsSync(FALLBACK_FAKE_CURSOR_AGENT),
  };
}

/**
 * Copies the stand-in into `directory` as `cursor-agent`, the name probing
 * resolves for the Cursor target, and returns `directory` for use as `PATH`.
 *
 * @example
 * const path = await installFakeCursorAgent(fake, join(home, 'bin'));
 */
export async function installFakeCursorAgent(
  fake: FakeCursorAgent,
  directory: string
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, executable('cursor-agent'));
  await copyFile(fake.path, target);
  await chmod(target, 0o755);
  return directory;
}

/**
 * Grants every consent, `externalAgents` included, for `slot` under
 * `mangoHome`, through the binary's own `setup`.
 *
 * @example
 * await grantRuntimeConsent(binary.path, mangoHome, 'host');
 */
export async function grantRuntimeConsent(
  binaryPath: string,
  mangoHome: string,
  slot: 'host' | 'remote'
): Promise<void> {
  await setRuntimeConsent(binaryPath, mangoHome, slot, 'full');
}

/**
 * Withdraws every consent for `slot` under `mangoHome`, as a user running
 * `setup --profile none` on that machine would.
 *
 * @example
 * await revokeRuntimeConsent(binary.path, mangoHome, 'host');
 */
export async function revokeRuntimeConsent(
  binaryPath: string,
  mangoHome: string,
  slot: 'host' | 'remote'
): Promise<void> {
  await setRuntimeConsent(binaryPath, mangoHome, slot, 'none');
}

async function setRuntimeConsent(
  binaryPath: string,
  mangoHome: string,
  slot: 'host' | 'remote',
  profile: 'full' | 'none'
): Promise<void> {
  const setup = Bun.spawn({
    cmd: [binaryPath, 'setup', '--slot', slot, '--profile', profile],
    env: { ...process.env, MANGO_HOME: mangoHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await setup.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(setup.stderr).text();
    throw new Error(
      `expected "setup --slot ${slot} --profile ${profile}" to exit 0 | received: ${exitCode}: ${stderr}`
    );
  }
}

/**
 * Inserts an external-runner chat for the Cursor target whose workdir is
 * `workdir` on `environmentId` — the row `hub.workspace.authorize` answers from.
 *
 * @example
 * const chatId = await insertCursorChat(user.id, 'rust-box', workspace);
 */
export async function insertCursorChat(
  userId: string,
  environmentId: string,
  workdir: string
): Promise<string> {
  const id = `chat-${crypto.randomUUID()}`;
  await getDb()
    .insertInto('chats')
    .values({
      id,
      title: 'rust external-agent qualification',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: null,
      userId,
      runnerKind: 'external',
      runnerTargetId: 'cursor',
      workdir,
      environmentId,
    })
    .execute();
  return id;
}

export interface RustTurnHarness {
  /** Starts a turn on `chatId`, answering nothing. */
  start(prompt: string): Promise<ExternalTurnResult>;
  /** The approval the running turn is waiting on, once it has been recorded. */
  pendingApproval(): Promise<ExternalApprovalPart>;
  /** Answers the running turn's pending approval through the hub's own registry. */
  answer(approval: ExternalApprovalPart, optionId: string): Promise<{ status: string }>;
  /** The id of the assistant message the running turn is writing. */
  runningAssistantMessageId(): Promise<string>;
  /** The persisted assistant row for `messageId`. */
  assistantRow(messageId: string): Promise<{ text: string; parts: MessagePart[] }>;
  /** Closes the chat's vendor session the way a hub-side reap does. */
  close(): Promise<void>;
  liveSessionCount(): number;
}

export interface RustTurnHarnessOptions {
  readonly client: RuntimeClient;
  readonly userId: string;
  readonly chatId: string;
  readonly workspace: string;
  readonly credentialHomeFingerprint: string;
}

const CONFIGURATION: ExternalAgentConfiguration = {
  level: 'default',
  routing: 'user',
  workspaceRoots: [],
};

/**
 * The hub's own session manager, approval registry and turn controller,
 * resolving every runtime call to `client`.
 *
 * @example
 * const turns = createRustTurnHarness({ client, userId, chatId, workspace, credentialHomeFingerprint });
 * const running = turns.start('say hello');
 * await turns.answer(await turns.pendingApproval(), 'allow');
 * expect((await running).reason).toBe('completed');
 */
export function createRustTurnHarness(options: RustTurnHarnessOptions): RustTurnHarness {
  const { client, userId, chatId } = options;
  const sessions = createExternalSessionManager({
    resolveRuntimeClient: () => Promise.resolve(client),
    resolveExistingRuntimeClient: () => Promise.resolve(client),
  });
  const approvals = createExternalApprovalRegistry();
  const controller = createExternalTurnController({
    sessions,
    approvals,
    commandCatalog: createExternalCommandCatalogCache(),
  });

  async function runningRow() {
    return await getDb()
      .selectFrom('messages')
      .select(['id', 'parts'])
      .where('chatId', '=', chatId)
      .where('role', '=', 'ai')
      .where('isGenerating', '=', 1)
      .executeTakeFirst();
  }

  return {
    start: (prompt) =>
      controller.start(
        {
          userId,
          chatId,
          prompt,
          configuration: CONFIGURATION,
          canonicalWorkspacePath: options.workspace,
          credentialHomeFingerprint: options.credentialHomeFingerprint,
        },
        getDb()
      ),
    async pendingApproval() {
      let lastParts = '<no running assistant row>';
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const row = await runningRow();
        if (row?.parts) {
          lastParts = row.parts;
          const parts = JSON.parse(row.parts) as MessagePart[];
          const pending = parts.find(
            (part): part is ExternalApprovalPart =>
              part.type === 'external_approval' && part.decisionSource === undefined
          );
          if (pending && approvals.pendingCount(chatId) === 1) return pending;
        }
        await Bun.sleep(25);
      }
      throw new Error(
        `expected a pending external_approval part on the running turn | received: ${lastParts}`
      );
    },
    answer: (approval, optionId) =>
      controller.answerApproval({ userId, chatId, requestId: approval.requestId, optionId }),
    async runningAssistantMessageId() {
      const row = await runningRow();
      if (!row) throw new Error('expected a running assistant message | received: none');
      return row.id;
    },
    async assistantRow(messageId) {
      const row = await getDb()
        .selectFrom('messages')
        .select(['text', 'parts'])
        .where('id', '=', messageId)
        .executeTakeFirstOrThrow();
      return { text: row.text, parts: row.parts ? (JSON.parse(row.parts) as MessagePart[]) : [] };
    },
    close: () => sessions.reapChat(chatId, 'interrupted'),
    liveSessionCount: () => sessions.liveSessionCount(),
  };
}

/** The `external_turn` part of a finished assistant row. */
export function turnPartOf(parts: readonly MessagePart[]): ExternalTurnPart {
  const part = parts.find((entry): entry is ExternalTurnPart => entry.type === 'external_turn');
  if (!part) {
    throw new Error(
      `expected an external_turn part | received part types: ${parts.map((entry) => entry.type).join(', ')}`
    );
  }
  return part;
}

/**
 * Resolves with `promise`, or fails naming `label` once `timeoutMs` passes, so
 * a turn that never ends fails as that turn rather than as the test timeout.
 *
 * @example
 * expect((await within(turns.start('hi'), 'the first turn')).reason).toBe('completed');
 */
export async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 20_000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`expected ${label} to settle within ${timeoutMs} ms | received: still pending`)
        ),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one turn to completion by allowing the approval the stand-in vendor
 * asks for, and returns its result and persisted assistant row.
 *
 * @example
 * const { result, row } = await runAnsweredTurn(turns, 'hello over serve');
 * expect(result.reason).toBe('completed');
 */
export async function runAnsweredTurn(turns: RustTurnHarness, prompt: string) {
  const running = turns.start(prompt);
  const approval = await turns.pendingApproval();
  const messageId = await turns.runningAssistantMessageId();
  const answer = await turns.answer(approval, 'allow');
  if (answer.status !== 'accepted') {
    throw new Error(`expected the hub to accept the approval answer | received: ${answer.status}`);
  }
  const result = await within(running, `the answered turn "${prompt}"`);
  return { result, approval, row: await turns.assistantRow(messageId) };
}
