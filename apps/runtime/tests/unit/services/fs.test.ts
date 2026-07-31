import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFileFreshness, PathAccessError } from '../../../src';
import { runtimeFsService } from '../../../src/services/fs';

let tempDir: string;

beforeEach(() => {
  clearFileFreshness();
  tempDir = mkdtempSync(join(tmpdir(), 'runtime-fs-test-'));
});

afterEach(() => {
  clearFileFreshness();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runtime filesystem service', () => {
  it('owns the read-modify-write freshness lifecycle and returns snapshots', async () => {
    const path = join(tempDir, 'nested', 'file.txt');
    const created = await runtimeFsService.createFile({
      chatId: 'chat-1',
      inputPath: 'nested/file.txt',
      resolvedPath: path,
      content: 'before\n',
      captureSnapshot: true,
    });

    expect(created.result).toMatchObject({
      path: 'nested/file.txt',
      bytesWritten: 7,
    });
    expect(created.mutations).toEqual([
      {
        path,
        op: 'create',
        before: { exists: false },
        afterHash: created.result.sha256,
      },
    ]);

    const read = await runtimeFsService.readFile({
      chatId: 'chat-1',
      inputPath: 'nested/file.txt',
      resolvedPath: path,
    });
    expect(read.content).toContain('before');

    const edited = await runtimeFsService.editFile({
      chatId: 'chat-1',
      inputPath: 'nested/file.txt',
      resolvedPath: path,
      oldString: 'before',
      newString: 'after',
      captureSnapshot: true,
    });
    expect(edited.result.replacements).toBe(1);
    expect(edited.mutations[0]).toMatchObject({
      path,
      op: 'edit',
      before: {
        exists: true,
        contentBase64: Buffer.from('before\n').toString('base64'),
      },
      afterHash: edited.result.sha256,
    });
    expect(await Bun.file(path).text()).toBe('after\n');
  });

  it('filters glob results by denied roots and real-path containment', async () => {
    const root = join(tempDir, 'workspace');
    const denied = join(root, 'private');
    const outside = join(tempDir, 'outside');
    mkdirSync(denied, { recursive: true });
    mkdirSync(outside, { recursive: true });
    await Bun.write(join(root, 'visible.txt'), 'visible');
    await Bun.write(join(denied, 'secret.txt'), 'secret');
    await Bun.write(join(outside, 'escaped.txt'), 'escaped');
    symlinkSync(outside, join(root, 'escape'));

    const result = await runtimeFsService.glob({
      pattern: '**/*.txt',
      cwd: root,
      maxResults: 100,
      includeDotfiles: false,
      absolute: true,
      pathPolicy: { allowedRoots: [root], deniedRoots: [denied], containmentRoot: root },
    });

    expect(result.matches).toEqual([join(root, 'visible.txt')]);
  });

  it('matches inside a containment root reached through a symlink', async () => {
    const real = join(tempDir, 'real-workspace');
    const linked = join(tempDir, 'linked-workspace');
    mkdirSync(real, { recursive: true });
    await Bun.write(join(real, 'visible.txt'), 'visible');
    symlinkSync(real, linked);

    const result = await runtimeFsService.glob({
      pattern: '**/*.txt',
      cwd: linked,
      maxResults: 100,
      includeDotfiles: false,
      absolute: true,
      // The hub sends the workdir lexically. Candidates are matched link-resolved,
      // so an uncanonicalized root here excludes everything inside itself.
      pathPolicy: { allowedRoots: [], deniedRoots: [], containmentRoot: linked },
    });

    expect(result.matches).toEqual([join(linked, 'visible.txt')]);
  });

  it('denies a symlink whose target resolves into a denied root', async () => {
    const root = join(tempDir, 'workspace');
    const denied = join(root, 'private');
    mkdirSync(denied, { recursive: true });
    await Bun.write(join(denied, 'secret.txt'), 'secret');
    // Lexically "alias.txt" sits directly in the allowed root; only the resolved
    // target is denied.
    symlinkSync(join(denied, 'secret.txt'), join(root, 'alias.txt'));

    const result = await runtimeFsService.glob({
      pattern: '*.txt',
      cwd: root,
      maxResults: 100,
      includeDotfiles: false,
      absolute: true,
      pathPolicy: { allowedRoots: [root], deniedRoots: [denied] },
    });

    expect(result.matches).toEqual([]);
  });

  it('applies the path filter when grep targets a single file', async () => {
    const root = join(tempDir, 'workspace');
    const denied = join(root, 'private');
    mkdirSync(denied, { recursive: true });
    await Bun.write(join(denied, 'secret.txt'), 'token = hunter2');
    symlinkSync(join(denied, 'secret.txt'), join(root, 'alias.txt'));

    await expect(
      runtimeFsService.grep({
        pattern: 'hunter2',
        inputPath: 'alias.txt',
        resolvedPath: join(root, 'alias.txt'),
        caseInsensitive: false,
        maxResults: 10,
        maxMatchesPerFile: 10,
        maxFileSizeBytes: 1_000_000,
        includeDotfiles: false,
        pathPolicy: { allowedRoots: [root], deniedRoots: [denied] },
      })
    ).rejects.toThrow(PathAccessError);
  });
});

/**
 * The hub checks these paths too, but only lexically: it cannot see that a name
 * inside the working directory is a link out of it, because the link is on this
 * filesystem and not the hub's. These cover the paths the hub names directly —
 * the ones that reach the disk without a walk to filter them.
 */
describe('runtime filesystem path policy', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = join(tempDir, 'workspace');
    outside = join(tempDir, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });

  it('refuses to read through a symlink that leaves the containment root', async () => {
    await Bun.write(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'alias.txt'));

    await expect(
      runtimeFsService.readFile({
        chatId: 'chat-policy',
        inputPath: 'alias.txt',
        resolvedPath: join(root, 'alias.txt'),
        pathPolicy: { allowedRoots: [], deniedRoots: [], containmentRoot: root },
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses a move whose destination escapes through a linked directory', async () => {
    await Bun.write(join(root, 'file.txt'), 'contents');
    symlinkSync(outside, join(root, 'link'));

    await expect(
      runtimeFsService.moveFile({
        chatId: 'chat-policy',
        inputFrom: 'file.txt',
        inputTo: 'link/file.txt',
        resolvedFrom: join(root, 'file.txt'),
        resolvedTo: join(root, 'link', 'file.txt'),
        captureSnapshot: false,
        pathPolicy: { allowedRoots: [], deniedRoots: [], containmentRoot: root },
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses a patch operation that targets a denied root', async () => {
    const denied = join(root, 'private');
    mkdirSync(denied, { recursive: true });

    await expect(
      runtimeFsService.applyPatch({
        chatId: 'chat-policy',
        captureSnapshot: false,
        operations: [
          {
            type: 'add',
            inputPath: 'private/new.txt',
            resolvedPath: join(denied, 'new.txt'),
            content: 'planted',
          },
        ],
        pathPolicy: { allowedRoots: [], deniedRoots: [denied] },
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('leaves calls without a policy unrestricted', async () => {
    const created = await runtimeFsService.createFile({
      chatId: 'chat-policy',
      inputPath: 'plain.txt',
      resolvedPath: join(outside, 'plain.txt'),
      content: 'ok\n',
      captureSnapshot: false,
    });

    expect(created.result.bytesWritten).toBe(3);
  });
});
