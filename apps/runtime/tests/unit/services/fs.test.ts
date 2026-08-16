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

/**
 * Every method that reaches a path the hub named, one case each.
 *
 * Deliberately not one loop over a list, and deliberately not an aggregate: a
 * method wired into the service without a policy guard is exactly the gap this
 * covers, and a table that iterates whatever the service happens to export
 * would grow a green row for it. Each case here names its method, so adding a
 * twelfth without adding a row leaves the omission visible rather than covered.
 */
describe('containment holds for every path the hub names', () => {
  let root: string;
  let outside: string;
  /** Inside the root by name, outside it by target. Invisible to the hub. */
  let escapeLink: string;

  beforeEach(async () => {
    root = join(tempDir, 'workspace');
    outside = join(tempDir, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    await Bun.write(join(outside, 'secret.txt'), 'secret\n');
    escapeLink = join(root, 'escape.txt');
    symlinkSync(join(outside, 'secret.txt'), escapeLink);
  });

  const contained = () => ({ allowedRoots: [], deniedRoots: [], containmentRoot: root });

  it('refuses read_file', async () => {
    await expect(
      runtimeFsService.readFile({
        chatId: 'chat-contained',
        inputPath: 'escape.txt',
        resolvedPath: escapeLink,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses list_directory', async () => {
    const dirLink = join(root, 'escape-dir');
    symlinkSync(outside, dirLink);

    await expect(
      runtimeFsService.listDirectory({
        inputPath: 'escape-dir',
        resolvedPath: dirLink,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses write_file', async () => {
    await expect(
      runtimeFsService.writeFile({
        chatId: 'chat-contained',
        inputPath: 'escape.txt',
        resolvedPath: escapeLink,
        content: 'planted\n',
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses create_file', async () => {
    const dirLink = join(root, 'escape-dir');
    symlinkSync(outside, dirLink);

    await expect(
      runtimeFsService.createFile({
        chatId: 'chat-contained',
        inputPath: 'escape-dir/planted.txt',
        resolvedPath: join(dirLink, 'planted.txt'),
        content: 'planted\n',
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses edit_file', async () => {
    await expect(
      runtimeFsService.editFile({
        chatId: 'chat-contained',
        inputPath: 'escape.txt',
        resolvedPath: escapeLink,
        oldString: 'secret',
        newString: 'planted',
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses replace_range', async () => {
    await expect(
      runtimeFsService.replaceRange({
        chatId: 'chat-contained',
        inputPath: 'escape.txt',
        resolvedPath: escapeLink,
        startLine: 1,
        endLine: 1,
        content: 'planted\n',
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses delete_file', async () => {
    await expect(
      runtimeFsService.deleteFile({
        chatId: 'chat-contained',
        inputPath: 'escape.txt',
        resolvedPath: escapeLink,
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses move_file at either end', async () => {
    await Bun.write(join(root, 'inside.txt'), 'contents\n');
    const dirLink = join(root, 'escape-dir');
    symlinkSync(outside, dirLink);

    await expect(
      runtimeFsService.moveFile({
        chatId: 'chat-contained',
        inputFrom: 'inside.txt',
        inputTo: 'escape-dir/moved.txt',
        resolvedFrom: join(root, 'inside.txt'),
        resolvedTo: join(dirLink, 'moved.txt'),
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);

    await expect(
      runtimeFsService.moveFile({
        chatId: 'chat-contained',
        inputFrom: 'escape.txt',
        inputTo: 'moved.txt',
        resolvedFrom: escapeLink,
        resolvedTo: join(root, 'moved.txt'),
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses apply_patch', async () => {
    await expect(
      runtimeFsService.applyPatch({
        chatId: 'chat-contained',
        captureSnapshot: false,
        operations: [{ type: 'delete', inputPath: 'escape.txt', resolvedPath: escapeLink }],
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  it('refuses glob and grep rooted on a link out of the workdir', async () => {
    const dirLink = join(root, 'escape-dir');
    symlinkSync(outside, dirLink);

    const globbed = await runtimeFsService.glob({
      pattern: '**/*.txt',
      cwd: root,
      maxResults: 100,
      includeDotfiles: false,
      absolute: true,
      pathPolicy: contained(),
    });
    expect(globbed.matches).toEqual([]);

    await expect(
      runtimeFsService.grep({
        pattern: 'secret',
        inputPath: 'escape.txt',
        resolvedPath: escapeLink,
        caseInsensitive: false,
        maxResults: 10,
        maxMatchesPerFile: 10,
        maxFileSizeBytes: 1_000_000,
        includeDotfiles: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });

  /**
   * A create names a leaf that does not exist yet, so the guard has nothing to
   * canonicalize at the target itself and walks up to the nearest ancestor that
   * does exist. Both directions matter: refusing this would break every
   * legitimate create inside a restricted chat.
   */
  it('allows a create whose leaf is missing but whose parent is inside the root', async () => {
    const created = await runtimeFsService.createFile({
      chatId: 'chat-contained',
      inputPath: 'nested/deep/new.txt',
      resolvedPath: join(root, 'nested', 'deep', 'new.txt'),
      content: 'ok\n',
      captureSnapshot: false,
      pathPolicy: contained(),
    });

    expect(created.result.bytesWritten).toBe(3);
  });

  it('refuses a create whose leaf is missing and whose parent is outside the root', async () => {
    await expect(
      runtimeFsService.createFile({
        chatId: 'chat-contained',
        inputPath: 'new.txt',
        resolvedPath: join(outside, 'nested', 'new.txt'),
        content: 'planted\n',
        captureSnapshot: false,
        pathPolicy: contained(),
      })
    ).rejects.toThrow(PathAccessError);
  });
});
