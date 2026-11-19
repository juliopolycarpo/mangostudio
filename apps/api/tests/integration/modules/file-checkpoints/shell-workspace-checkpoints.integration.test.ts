/**
 * Opt-in workspace checkpoints for shell commands.
 *
 * A shell command's writes are unknown before it runs, so with
 * `checkpointWorkspaceWrites` on the hub snapshots the files git tracks or
 * would track under the chat workdir, runs the command, and records what
 * changed. These run real bash calls against a real git repository through the
 * generation layer, then revert the turn and read the disk back: what matters
 * is the restored bytes, not the manifest rows.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { isShellAvailable } from '@mangostudio/shared/process/host';
import { fixtures } from '@mangostudio/shared/test-utils';

import { getDb } from '../../../../src/db/database';
import { listChatFileCheckpointSummaries } from '../../../../src/modules/file-checkpoints/application/list-chat-checkpoints';
import { revertMessageFileCheckpoints } from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import { executeStandardToolCallsWithProgress } from '../../../../src/modules/generation/application/standard-tool-execution';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import { registerTools } from '../../../../src/services/tools/register-tools';
import type { EffectiveToolSettings } from '../../../../src/services/tools/types';
import { bashPath } from '../../../support/bash-path';
import { type ChatFixture, insertTestChat, type UserFixture } from '../../../support/factories';
import { insertUserWithLocalRuntime } from '../../../support/fixtures/local-runtime-user';
import { gitFixtureEnv } from '../../../support/git-fixture-env';

const hasBash = isShellAvailable('bash');
const hasGit = Bun.which('git') !== null;
const runnable = hasBash && hasGit;

let workdir: string;
let chat: ChatFixture;
let messageId: string;
let user: UserFixture;

registerTools();

beforeAll(async () => {
  user = await insertUserWithLocalRuntime();
});

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'shell-workspace-checkpoints-'));
  chat = await insertTestChat(user.id);
  messageId = fixtures.uuid();
  await insertMessage(
    {
      id: messageId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      timestamp: Date.now(),
      isGenerating: false,
      interactionMode: 'chat',
    },
    getDb()
  );
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function shellSettings(checkpointWorkspaceWrites: boolean): EffectiveToolSettings {
  return {
    enabled: true,
    parameters: {
      timeoutSeconds: 30,
      maxOutputBytes: 10_000,
      allowedEnvVars: [],
      deniedEnvVars: [],
      checkpointWorkspaceWrites,
    },
  };
}

type ToolCall = [string, { name: string; argsStr: string }];

function bashCall(callId: string, command: string, cwd: string | null = null): ToolCall {
  return [callId, { name: 'bash', argsStr: JSON.stringify({ command, cwd }) }];
}

function writeFileCall(callId: string, path: string, content: string): ToolCall {
  return [callId, { name: 'write_file', argsStr: JSON.stringify({ path, content }) }];
}

/** write_file refuses to overwrite a file the chat has not read. */
function readFileCall(callId: string, path: string): ToolCall {
  return [callId, { name: 'read_file', argsStr: JSON.stringify({ path }) }];
}

/** Calls run in order, the way a streaming turn executes them. */
async function runCalls(calls: ToolCall[], checkpointWorkspaceWrites = true) {
  for await (const _item of executeStandardToolCallsWithProgress(calls, {
    userId: chat.userId,
    chatId: chat.id,
    environmentId: LOCAL_ENVIRONMENT_ID,
    assistantMessageId: messageId,
    workdir,
    db: getDb(),
    settingsByToolName: new Map([['bash', shellSettings(checkpointWorkspaceWrites)]]),
    allowedToolNames: new Set(['bash', 'write_file', 'read_file']),
  })) {
    // Drained for its effects; the filesystem and manifest are asserted below.
  }
}

async function runBash(
  command: string,
  checkpointWorkspaceWrites = true,
  cwd: string | null = null
) {
  await runCalls([bashCall('call-1', command, cwd)], checkpointWorkspaceWrites);
}

function git(...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: workdir, env: gitFixtureEnv() });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${workdir}: expected exit 0 | received ${result.exitCode}: ${result.stderr.toString()}`
    );
  }
}

/** A repository with one commit holding `files`, plus whatever `.gitignore` names. */
function initRepository(files: Record<string, string | Uint8Array>, ignore = ''): void {
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(workdir, '.gitignore'), ignore);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(workdir, name, '..'), { recursive: true });
    writeFileSync(join(workdir, name), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
}

async function storedSources(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom('message_uncheckpointed_sources')
    .select('source')
    .where('chatId', '=', chat.id)
    .where('messageId', '=', messageId)
    .execute();
  return rows.map((row) => row.source);
}

function revert() {
  return revertMessageFileCheckpoints(getDb(), chat.id, messageId);
}

function read(name: string): string {
  return readFileSync(join(workdir, name), 'utf8');
}

describe.skipIf(!runnable)('shell workspace checkpoints', () => {
  it('restores edited, created and deleted files and leaves ignored output alone', async () => {
    initRepository({ 'a.txt': 'a-original\n', 'b.txt': 'b-original\n' }, 'out/\n');
    await runBash(
      "printf 'a-shell\\n' > a.txt; rm b.txt; printf 'new\\n' > c.txt; mkdir -p out; printf 'artifact\\n' > out/build.bin"
    );

    expect(await storedSources()).toEqual([]);
    expect(await revert()).toEqual({ revertedFiles: 3, uncheckpointedSources: [] });
    expect(read('a.txt')).toBe('a-original\n');
    expect(read('b.txt')).toBe('b-original\n');
    expect(existsSync(join(workdir, 'c.txt'))).toBe(false);
    // Ignored output is outside the covered set by design: revert must not
    // reach into a build directory it never snapshotted.
    expect(read('out/build.bin')).toBe('artifact\n');
  });

  it('restores the uncommitted bytes a file held before the command, not HEAD', async () => {
    initRepository({ 'a.txt': 'committed\n' });
    writeFileSync(join(workdir, 'a.txt'), 'uncommitted work\n');
    await runBash("printf 'clobbered\\n' > a.txt");

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(read('a.txt')).toBe('uncommitted work\n');
  });

  it('restores binary content byte for byte', async () => {
    const binary = new Uint8Array([
      0xef, 0xbb, 0xbf, 0x00, 0xff, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0d, 0x0a,
    ]);
    initRepository({ 'data.bin': binary });
    await runBash("printf 'text now\\n' > data.bin");

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(new Uint8Array(readFileSync(join(workdir, 'data.bin')))).toEqual(binary);
  });

  it('checkpoints the writes of a command that then fails', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    await runBash("printf 'half-done\\n' > a.txt; exit 3");

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(read('a.txt')).toBe('a-original\n');
  });

  it('records nothing for a command that changes nothing', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    await runBash('cat a.txt');

    expect(await storedSources()).toEqual([]);
    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: [] });
  });

  it('keeps today’s disclosure when the option is off', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    await runBash("printf 'a-shell\\n' > a.txt", false);

    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: ['shell'] });
    expect(read('a.txt')).toBe('a-shell\n');
  });

  it('falls back to the disclosure outside a git repository', async () => {
    writeFileSync(join(workdir, 'a.txt'), 'a-original\n');
    await runBash("printf 'a-shell\\n' > a.txt");

    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: ['shell'] });
    expect(read('a.txt')).toBe('a-shell\n');
  });

  it('falls back to the disclosure when the workspace has too many files to snapshot', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 501; index++) files[`bulk/f${index}.txt`] = `${index}\n`;
    initRepository(files);
    await runBash("printf 'a-shell\\n' > bulk/f0.txt");

    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: ['shell'] });
    expect(read('bulk/f0.txt')).toBe('a-shell\n');
  });

  it('falls back to the disclosure when the workspace holds too many bytes to snapshot', async () => {
    const chunk = 'x'.repeat(6 * 1024 * 1024);
    initRepository({ 'big1.txt': chunk, 'big2.txt': chunk, 'big3.txt': chunk });
    await runBash("printf 'a-shell\\n' > big1.txt");

    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: ['shell'] });
    expect(read('big1.txt')).toBe('a-shell\n');
  });

  it('does not claim coverage for a command that runs outside the workdir', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    const outside = mkdtempSync(join(tmpdir(), 'shell-workspace-outside-'));
    try {
      await runBash(`printf 'x\\n' > ${bashPath(join(outside, 'o.txt'))}`, true, outside);
      expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: ['shell'] });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never deletes a pre-existing ignored file when the command un-ignores it', async () => {
    initRepository({ 'a.txt': 'a\n' }, 'secret.env\n');
    writeFileSync(join(workdir, 'secret.env'), 'API_KEY=1\n');
    await runBash("printf '' > .gitignore");

    // secret.env now looks untracked-and-new, but it was there all along: a
    // revert that removed it would destroy a file the command never created.
    await revert();
    expect(read('secret.env')).toBe('API_KEY=1\n');
    expect(await storedSources()).toEqual(['shell']);
  });

  it('never deletes a pre-existing ignored file the command force-adds', async () => {
    initRepository({ 'a.txt': 'a\n' }, 'cache/\n');
    mkdirSync(join(workdir, 'cache'));
    writeFileSync(join(workdir, 'cache', 'kept.txt'), 'cached\n');
    await runBash('git add -f cache/kept.txt');

    await revert();
    expect(read('cache/kept.txt')).toBe('cached\n');
  });

  it('reverts a file a builtin tool and a shell command both changed to its first state', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    const path = join(workdir, 'a.txt');
    await runCalls([
      readFileCall('call-0', path),
      writeFileCall('call-1', path, 'from write_file\n'),
      bashCall('call-2', "printf 'from bash\\n' > a.txt"),
    ]);

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(read('a.txt')).toBe('a-original\n');
  });

  it('reverts a file a shell command and then a builtin tool changed to its first state', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    const path = join(workdir, 'a.txt');
    await runCalls([
      bashCall('call-1', "printf 'from bash\\n' > a.txt"),
      readFileCall('call-2', path),
      writeFileCall('call-3', path, 'from write_file\n'),
    ]);

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(read('a.txt')).toBe('a-original\n');
  });

  // The revert dialog warns about concurrent writers only for turns whose rows
  // came from a before/after comparison; a builtin-only turn has no such row.
  describe('includesShellCapture in the revert preview', () => {
    async function previewFlag(): Promise<boolean | undefined> {
      const summaries = await listChatFileCheckpointSummaries(getDb(), chat.id);
      return summaries.find((summary) => summary.messageId === messageId)?.includesShellCapture;
    }

    it('is true when a row came from a shell workspace capture', async () => {
      initRepository({ 'a.txt': 'a-original\n' });
      await runBash("printf 'a-shell\\n' > a.txt");

      expect(await previewFlag()).toBe(true);
    });

    it('is false when only builtin tools wrote', async () => {
      initRepository({ 'a.txt': 'a-original\n' });
      const path = join(workdir, 'a.txt');
      await runCalls([readFileCall('call-1', path), writeFileCall('call-2', path, 'built in\n')]);

      expect(await previewFlag()).toBe(false);
    });

    it('is false when the shell ran without workspace checkpoints', async () => {
      initRepository({ 'a.txt': 'a-original\n' });
      const path = join(workdir, 'a.txt');
      await runCalls(
        [
          readFileCall('call-1', path),
          writeFileCall('call-2', path, 'built in\n'),
          bashCall('call-3', "printf 'a-shell\\n' > a.txt"),
        ],
        false
      );

      expect(await previewFlag()).toBe(false);
    });

    it('is true when a shell capture widens a row a builtin call opened', async () => {
      initRepository({ 'a.txt': 'a-original\n' });
      const path = join(workdir, 'a.txt');
      await runCalls([
        readFileCall('call-1', path),
        writeFileCall('call-2', path, 'built in\n'),
        bashCall('call-3', "printf 'from bash\\n' > a.txt"),
      ]);

      expect(await previewFlag()).toBe(true);
    });
  });

  // A file that predates the command is never the command's to lose, whatever
  // the snapshot managed to read about it. Root ignores file modes, and Windows
  // has no mode bits to deny a read with.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never deletes a pre-existing file the snapshot could not read once the command makes it readable',
    async () => {
      initRepository({ 'a.txt': 'a\n' });
      const locked = join(workdir, 'locked.txt');
      writeFileSync(locked, 'precious\n', { mode: 0o000 });
      chmodSync(locked, 0o000);
      await runBash("chmod 644 locked.txt; printf 'touched\\n' >> locked.txt");

      await revert();
      expect(existsSync(locked)).toBe(true);
      expect(read('locked.txt')).toBe('precious\ntouched\n');
      // Nothing could be restored for it, so the call is not fully covered.
      expect(await storedSources()).toEqual(['shell']);
    }
  );

  // A case-sensitive disk cannot hold one file under two spellings, so the alias
  // a case-insensitive volume gives for free is made by hand: `Foo.ts` becomes a
  // link to the renamed `foo.ts`. Hashing either name reads the same bytes, as
  // it would there, and the listing carries `foo.ts` as a new path.
  it.skipIf(process.platform === 'win32')(
    'leaves the only copy of a case-only rename alone when git folds case',
    async () => {
      initRepository({ 'Foo.ts': 'export const foo = 1;\n' });
      git('config', 'core.ignorecase', 'true');
      await runBash('git mv Foo.ts foo.ts && ln -s foo.ts Foo.ts');

      await revert();
      expect(read('foo.ts')).toBe('export const foo = 1;\n');
      expect(read('Foo.ts')).toBe('export const foo = 1;\n');
      expect(await storedSources()).toEqual(['shell']);
    }
  );

  // The real thing: git init sets core.ignorecase on a case-insensitive volume
  // by itself, and `foo.ts` then names the file `Foo.ts` already holds.
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
    'keeps the only copy of a case-only rename on a case-insensitive filesystem',
    async () => {
      initRepository({ 'Foo.ts': 'export const foo = 1;\n' });
      await runBash('git mv Foo.ts foo.ts');

      await revert();
      const survivors = readdirSync(workdir).filter((name) => name.toLowerCase() === 'foo.ts');
      expect(survivors.length).toBe(1);
      expect(read(survivors[0] as string)).toBe('export const foo = 1;\n');
    }
  );

  it('does not claim a file whose modification time says the command did not write it', async () => {
    initRepository({ 'a.txt': 'a\n' });
    // Another process's file looks the same from the listing: new, regular and
    // not ignored. Its timestamp is the only thing that places it before the run.
    await runBash("printf 'not ours\\n' > older.txt; touch -d '2001-01-01 00:00:00' older.txt");

    await revert();
    expect(read('older.txt')).toBe('not ours\n');
    expect(await storedSources()).toEqual(['shell']);
  });

  it('still reverts a file the command moved, though a move keeps its modification time', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    utimesSync(join(workdir, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
    await runBash('mv a.txt moved.txt');

    expect(await revert()).toEqual({ revertedFiles: 2, uncheckpointedSources: [] });
    expect(read('a.txt')).toBe('a-original\n');
    expect(existsSync(join(workdir, 'moved.txt'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'leaves an untracked symlink a command wrote through exactly as it was',
    async () => {
      initRepository({ 'a.txt': 'a\n' }, 'real.txt\n');
      writeFileSync(join(workdir, 'real.txt'), 'real-original\n');
      symlinkSync('real.txt', join(workdir, 'link.txt'));
      await runBash("printf 'through the link\\n' > link.txt");

      // The target is ignored, so nothing covers it; the link is not a regular
      // file, so nothing may restore bytes over it.
      expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: [] });
      expect(lstatSync(join(workdir, 'link.txt')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(workdir, 'link.txt'))).toBe('real.txt');
      expect(read('real.txt')).toBe('through the link\n');
    }
  );

  it('refuses to revert over an edit made after the command', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    await runBash("printf 'a-shell\\n' > a.txt");
    writeFileSync(join(workdir, 'a.txt'), 'edited later\n');

    await expect(revert()).rejects.toThrow('changed on disk');
    expect(read('a.txt')).toBe('edited later\n');
  });
});
