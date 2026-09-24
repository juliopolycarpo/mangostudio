/**
 * Shared assertions for the real Rust `mangostudio-runtime` qualification
 * suite (stdio, direct-URL serve, and paired connect) — one place for the
 * exact wire shape all three transports must agree on, so a divergence
 * between them shows up as a shared assertion failing rather than three
 * copies quietly drifting apart.
 *
 * Every value asserted here is either fixed by this test's own setup (a
 * temp directory this file created and knows the real path of) or fixed by
 * the crate's own behaviour for a freshly auto-granted slot with no
 * `runtime.json` on disk (see `crates/mangostudio-runtime/src/consent/presets.rs`'s
 * `FULL` preset and `default_consent_for_slot`) — never normalized away.
 * `binaryPath`, `version`, and `homeDir` (the real developer/CI `$HOME`, not
 * the test's own temp directories) are the only genuinely volatile fields,
 * and this file does not assert them at all rather than papering over them.
 */

import { expect } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RemoteError } from '@mangostudio/protocol';
import { rejectionOf } from '@mangostudio/protocol/testing';
import { LIBRARY_LOCATION_DEFINITIONS } from '@mangostudio/shared/library/host';
import {
  createBackupStoreDeps,
  executeLibraryUndo,
  executePropagationWrites,
  hashResourceAt,
  LibraryCache,
  listBackupSets,
  readBackupManifest,
  scanLibraryInstances,
} from '@mangostudio/shared/library/machine';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-contract';
import {
  RUNTIME_CONSENT_PRESETS,
  type RuntimeHealthReport,
} from '@mangostudio/shared/runtime-home';
import type { RuntimeClient } from '../../src/services/runtime-client/runtime-client';
import { ToolArgumentError } from '../../src/services/tools/arg-parsing';

/**
 * Asserts `runtime.health`'s shape field-by-field against what
 * `crates/mangostudio-runtime/src/health.rs`'s own tests already assert is
 * correct for a freshly auto-granted slot — this only proves the wire round
 * trip through the real hub code reproduces it, never re-derives correctness.
 *
 * @example
 * assertRustRuntimeHealthShape(await client.health(), { slot: 'host' });
 */
export function assertRustRuntimeHealthShape(
  health: RuntimeHealthReport,
  expected: { readonly slot: 'host' | 'remote' }
): void {
  expect(health.schemaVersion).toBe(1);
  expect(health.slot).toBe(expected.slot);
  // A `target/debug` binary never sits inside any slot's managed install
  // layout, whichever slot it is asked to answer as.
  expect(health.source).toBe('bundled');
  expect(health.platform).toBe(process.platform);
  if (process.platform === 'win32') {
    expect(String(health.platformId)).toBe(`windows-${health.arch}`);
    expect(health.binaryPath?.endsWith('mangostudio-runtime.exe')).toBe(true);
  } else if (process.platform === 'darwin') {
    expect(String(health.platformId)).toBe(`darwin-${health.arch}`);
  } else {
    expect(health.platformId?.startsWith(`linux-${health.arch}`)).toBe(true);
  }
  // A freshly auto-granted slot with no stored `runtime.json` reports the
  // `full` preset: a `host` slot's own default, or the "invocation is
  // consent" grant `serve`/`connect` record for a never-seen `remote` slot.
  expect(health.allow).toEqual(RUNTIME_CONSENT_PRESETS.full);
  expect(health.profile).toBe('full');
  expect(health.setup?.state).toBe('configured');
  expect(typeof health.git.available).toBe('boolean');
  if (health.git.available) {
    expect(typeof health.git.version).toBe('string');
  }
  expect(typeof health.gh?.available).toBe('boolean');
  const expectedShell =
    process.platform === 'win32' ? 'powershell' : process.platform === 'darwin' ? 'zsh' : 'bash';
  expect(health.shells).toContain(expectedShell);
  expect(health.terminal).toBe(true);
  expect(health.lastError ?? null).toBeNull();
}

/**
 * Pins the real Rust host's implemented methods and their consent gates.
 *
 * @example
 * assertRustRuntimeFeatureCeiling(client.manifest, { probing: true, fsRead: true, fsWrite: true, checkpoints: true, mcp: true });
 */
export function assertRustRuntimeFeatureCeiling(
  manifest: RuntimeCapabilityManifest,
  expected: {
    readonly probing: boolean;
    readonly fsRead: boolean;
    readonly fsWrite: boolean;
    readonly checkpoints: boolean;
    readonly mcp: boolean;
  }
): void {
  // Every shell-capability method (shell.run, gh.mutate, install.*, terminal.*) is implemented,
  // so the feature follows shell consent alone.
  const shell = manifest.allow?.shell === true;
  const git = manifest.allow?.git === true && manifest.git.available;
  // All ten library methods are implemented, so the feature follows consent
  // exactly — the readonly preset included, which grants library alone.
  const library = manifest.allow?.library === true;
  expect(manifest.features).toEqual({
    tools:
      shell ||
      git ||
      expected.probing ||
      expected.fsRead ||
      expected.fsWrite ||
      expected.checkpoints ||
      expected.mcp ||
      library,
    git,
    probing: expected.probing,
    mcp: expected.mcp,
    library,
    checkpoints: expected.checkpoints,
    fsRead: expected.fsRead,
    fsWrite: expected.fsWrite,
    shell,
    update: manifest.allow?.update === true,
    // All ten external-agent methods are implemented: the feature follows consent.
    externalAgents: manifest.allow?.externalAgents === true,
    toolchain: true,
  });
  expect(manifest.enforcesPathPolicy).toBe(true);
  expect(manifest.terminal).toBe(manifest.allow?.shell === true && manifest.shells.length > 0);
  // The hub refuses every terminal from a runtime that does not attest revocation-safe close.
  expect(manifest.terminalCloseAfterRevocation).toBe(true);
}

/**
 * Exercises command handlers through the real Hub codec without remote mutations.
 *
 * @example
 * await assertRustRuntimeCommandMethods(client, scratchDirectory);
 */
export async function assertRustRuntimeCommandMethods(
  client: RuntimeClient,
  cwd: string
): Promise<void> {
  const kind = process.platform === 'win32' ? 'powershell' : 'bash';
  const command =
    kind === 'powershell'
      ? "[Console]::Out.Write('command output')"
      : "printf '%s' 'command output'";
  expect(
    await client.shell.run({ kind, command, cwd, timeoutMs: 5000, maxOutputBytes: 4096 })
  ).toMatchObject({
    stdout: 'command output',
    stderr: '',
    exitCode: 0,
    truncated: false,
    termination: { kind: 'exited' },
  });
  if (client.manifest.git.available) {
    expect((await client.git.exec({ args: ['--version'], cwd })).stdout).toMatch(/^git version /);
  }
  expect(typeof client.manifest.gh?.available).toBe('boolean');
  if (client.manifest.gh?.available) {
    expect((await client.gh.exec({ args: ['--version'], cwd })).stdout).toMatch(/^gh version /i);
    // Cobra handles help locally, before auth or a GitHub request.
    expect((await client.gh.mutate({ args: ['pr', 'create', '--help'], cwd })).exitCode).toBe(0);
  }
  const rejected = await rejectionOf(
    client.gh.exec({ args: ['pr', 'private rejected operand'], cwd })
  );
  expect(rejected).toBeInstanceOf(ToolArgumentError);
  expect(String(rejected)).not.toContain('private rejected operand');
}

/**
 * Exercises all three typed `probing.*` handlers over a real runtime
 * connection without depending on the CI machine's installed tools. Empty
 * selections still cross the full wire decoder; `latestByMajor` also proves
 * the JSON string-keyed map reaches Rust's numeric-keyed handler type.
 *
 * @example
 * await assertRustRuntimeProbingMethods(client);
 */
export async function assertRustRuntimeProbingMethods(client: RuntimeClient): Promise<void> {
  expect(await client.probing.runtimes({ ids: [] })).toEqual({ statuses: [] });
  expect(
    await client.probing.versionManagers({ ids: [], latestByMajor: { '20': '20.19.5' } })
  ).toEqual({ statuses: [] });
  expect(
    await client.probing.agentClis({
      targetIds: [],
      self: { version: 'qualification-test' },
    })
  ).toEqual({ statuses: [] });
}

/**
 * Exercises every filesystem method through the Hub client in an isolated directory.
 * @example
 * await assertRustRuntimeFilesystemMethods(client, scratchDirectory);
 */
export async function assertRustRuntimeFilesystemMethods(
  client: RuntimeClient,
  directory: string
): Promise<void> {
  const path = join(directory, 'example.txt');
  const moved = join(directory, 'moved.txt');
  const pathPolicy = { allowedRoots: [directory], deniedRoots: [], containmentRoot: directory };
  const common = { chatId: 'filesystem-qualification', captureSnapshot: true, pathPolicy };
  const file = { ...common, inputPath: 'example.txt', resolvedPath: path };
  const created = await client.fs.createFile({ ...file, content: 'one\r\ntwo\r\n' });
  expect(created.result.bytesWritten).toBe(10);
  expect(created.mutations[0]?.before).toEqual({ exists: false });
  expect((await client.fs.readFile(file)).content).toBe('     1\tone\r\n     2\ttwo\r');
  const edit = await client.fs.editFile({ ...file, oldString: 'one', newString: 'first' });
  expect(edit.result.replacements).toBe(1);
  expect(edit.mutations[0]?.before.contentBase64).toBe(
    Buffer.from('one\r\ntwo\r\n').toString('base64')
  );
  await client.fs.replaceRange({ ...file, startLine: 2, endLine: 2, content: 'second\r' });
  expect((await client.fs.readFile({ ...file, view: 'hex' })).content).toBe(
    Buffer.from('first\r\nsecond\r\n').toString('hex')
  );
  await client.fs.writeFile({ ...file, content: 'final\n' });
  expect(
    (await client.fs.listDirectory({ inputPath: '.', resolvedPath: directory, pathPolicy })).entries
  ).toEqual([{ name: 'example.txt', type: 'file' }]);
  expect(
    (
      await client.fs.glob({
        pattern: '*.txt',
        cwd: directory,
        maxResults: 10,
        includeDotfiles: false,
        absolute: false,
        pathPolicy,
      })
    ).matches
  ).toEqual(['example.txt']);
  const grep = await client.fs.grep({
    pattern: '(?<word>final)',
    inputPath: 'example.txt',
    resolvedPath: path,
    caseInsensitive: false,
    maxResults: 10,
    maxMatchesPerFile: 10,
    maxFileSizeBytes: 1024,
    includeDotfiles: false,
    pathPolicy,
  });
  expect(grep.matches).toEqual([{ file: path, line: 1, text: 'final' }]);
  await client.fs.applyPatch({
    ...common,
    operations: [
      {
        type: 'update',
        inputPath: 'example.txt',
        resolvedPath: path,
        hunks: [
          {
            lines: [
              { type: 'delete', content: 'final', ending: '\n' },
              { type: 'add', content: 'patched', ending: '\n' },
            ],
          },
        ],
      },
    ],
  });
  expect((await client.fs.readFile(file)).content).toBe('     1\tpatched');
  expect(
    (
      await client.fs.moveFile({
        ...common,
        inputFrom: 'example.txt',
        inputTo: 'moved.txt',
        resolvedFrom: path,
        resolvedTo: moved,
      })
    ).result.moved
  ).toBe(true);
  expect(
    (await client.fs.deleteFile({ ...common, inputPath: 'moved.txt', resolvedPath: moved })).result
      .deleted
  ).toBe(true);
}

/**
 * Runs one success and one error case each for `workspace.browse`,
 * `workspace.validate`, and `workspace.resolve-contained` against a real,
 * per-test temp directory — never the caller's real home — through
 * `client`'s real request path.
 *
 * `workspaceDir` must already be the *real*, symlink-resolved path (e.g. via
 * `node:fs/promises`' `realpath`): `resolve_workspace_path` on the Rust side
 * only lexically normalizes an already-absolute path, it never resolves a
 * symlink, so a `path` this test passes and the `resolvedPath`/`path` the
 * runtime echoes back must already be identical strings for the exact
 * equality checks below to hold.
 *
 * @example
 * await assertRustRuntimeWorkspaceMethods(client, workspaceDir);
 */
export async function assertRustRuntimeWorkspaceMethods(
  client: RuntimeClient,
  workspaceDir: string
): Promise<void> {
  await mkdir(join(workspaceDir, 'inner'));
  await writeFile(join(workspaceDir, 'inner', 'hello.txt'), 'from the qualification suite\n');

  // workspace.browse: success, then a directory that does not exist.
  const browsed = await client.workspace.browse({ path: workspaceDir });
  expect(browsed.path).toBe(workspaceDir);
  expect(browsed.entries).toEqual([
    { name: 'inner', path: join(workspaceDir, 'inner'), hidden: false },
  ]);

  const missingBrowse = (await rejectionOf(
    client.workspace.browse({ path: join(workspaceDir, 'does-not-exist') })
  )) as RemoteError;
  expect(missingBrowse.details).toMatchObject({
    kind: 'workspace_browser',
    code: 'FILESYSTEM',
    reason: 'not-found',
  });

  // workspace.validate: an ok result, a `{ ok: false }` result, and a thrown
  // shape error — the three genuinely distinct terminal outcomes this method
  // has, asserted exactly rather than merged into one "it answered" check.
  const validated = await client.workspace.validate({ path: workspaceDir });
  expect(validated).toEqual({ ok: true, resolvedPath: workspaceDir });

  const missingValidate = await client.workspace.validate({
    path: join(workspaceDir, 'does-not-exist'),
  });
  expect(missingValidate).toEqual({ ok: false, reason: 'not-found' });

  const emptyPathError = (await rejectionOf(
    client.workspace.validate({ path: '', requireAbsolute: true })
  )) as RemoteError;
  expect(emptyPathError.details).toMatchObject({
    kind: 'workdir_validation',
    code: 'VALIDATION',
  });

  // workspace.resolve-contained: a path inside the root, and one that escapes it.
  const resolved = await client.workspace.resolveContained({
    root: workspaceDir,
    path: 'inner/hello.txt',
  });
  expect(resolved).toEqual({ relativePath: join('inner', 'hello.txt') });

  const escaped = (await rejectionOf(
    client.workspace.resolveContained({ root: workspaceDir, path: '../escape' })
  )) as RemoteError;
  expect(escaped.details).toMatchObject({ kind: 'workspace_containment' });
}

/**
 * Exercises checkpoint capture, hashing and idempotent restore over the production client.
 *
 * @example
 * await assertRustRuntimeSnapshotMethods(client, workspaceDir);
 */
export async function assertRustRuntimeSnapshotMethods(
  client: RuntimeClient,
  workspaceDir: string
): Promise<void> {
  const path = join(workspaceDir, 'snapshot-roundtrip.bin');
  const before = Buffer.from([0, 255, 13, 10, 239, 187, 191]);
  const beforeHash = new Bun.CryptoHasher('sha256').update(before).digest('hex');
  expect(await client.snapshot.capture({ path })).toEqual({ exists: false });
  expect(await client.snapshot.hash({ path })).toEqual({ hash: null });
  await writeFile(path, before);
  expect(await client.snapshot.capture({ path })).toEqual({
    exists: true,
    contentBase64: before.toString('base64'),
    hash: beforeHash,
  });
  expect(await client.snapshot.hash({ path })).toEqual({ hash: beforeHash });
  const after = Buffer.from('changed bytes');
  const afterHash = new Bun.CryptoHasher('sha256').update(after).digest('hex');
  await writeFile(path, after);
  const revert = {
    chatId: 'snapshot-qualification',
    containmentRoot: workspaceDir,
    expected: [{ path, afterHash, revertedHash: beforeHash }],
    operations: [{ type: 'restore' as const, path, contentBase64: before.toString('base64') }],
  };
  expect(await client.snapshot.revert(revert)).toEqual({ revertedFiles: 1 });
  expect(await readFile(path)).toEqual(before);
  expect(await client.snapshot.revert(revert)).toEqual({ revertedFiles: 1 });
  expect(await client.snapshot.hash({ path })).toEqual({ hash: beforeHash });
}

/**
 * Exercises the ten `library.*` methods over the production client, diffs
 * the scan against the TypeScript reader on the same tree, and proves the
 * backup store is shared both ways: a set the Rust runtime writes is listed
 * and restored by the TypeScript engine, and a set the TypeScript engine
 * writes is listed and undone by the Rust runtime.
 *
 * `SKILLS_DIR`/`AGENTS_DIR` are pinned to scratch directories, every write
 * names a scratch `backupRoot`, and `locationSettings` enables nothing, so
 * only the two always-on MangoStudio locations are touched — never the real
 * home of the machine running the suite. The Hub's own library service is
 * qualified separately in `rust-runtime-library-qualification`.
 *
 * @example
 * await assertRustRuntimeLibraryMethods(client, scratchDirectory);
 */
export async function assertRustRuntimeLibraryMethods(
  client: RuntimeClient,
  directory: string
): Promise<void> {
  expect(client.manifest.features.library).toBe(true);
  const skills = join(directory, 'library-skills');
  const agents = join(directory, 'library-agents');
  const entrypoint = join(skills, 'qualified', 'SKILL.md');
  const skillText = '---\nname: qualified\ndescription: Read through the compiled runtime.\n---\n';
  await mkdir(join(skills, 'qualified'), { recursive: true });
  await mkdir(join(skills, 'Bad_Name'), { recursive: true });
  await mkdir(agents, { recursive: true });
  await writeFile(entrypoint, skillText);
  await writeFile(join(skills, 'Bad_Name', 'SKILL.md'), skillText);
  await writeFile(join(agents, 'reviewer.md'), '---\nname: Reviewer\n---\n');
  await writeFile(join(directory, 'outside.md'), 'not in any location');
  const env = { SKILLS_DIR: skills, AGENTS_DIR: agents };
  const pathEnv = { env };
  const locationSettings = { home: {}, workspace: {} };

  const scan = await client.library.scan({ locationSettings, force: true, pathEnv });
  const bySlug = <T extends { readonly ref: { readonly slug: string } }>(
    entries: readonly T[]
  ): T[] => [...entries].sort((left, right) => left.ref.slug.localeCompare(right.ref.slug));
  const reference = await scanLibraryInstances({
    locationSettings,
    pathEnv: { platform: process.platform, homeDir: homedir(), env },
    force: true,
    cache: new LibraryCache(),
  });
  expect(bySlug(scan.entries)).toEqual(
    bySlug(
      reference.instances.map((entry) => ({
        ref: entry.ref,
        instance: entry.instance,
        ...(entry.whitespaceHash !== undefined && { whitespaceHash: entry.whitespaceHash }),
      }))
    )
  );
  expect(scan.unreadableEntries).toEqual([...reference.unreadableEntries]);
  expect(
    bySlug(scan.entries).map((entry) => [
      entry.ref.slug,
      entry.instance.valid,
      entry.instance.valid ? undefined : entry.instance.invalidReason,
    ])
  ).toEqual([
    ['Bad_Name', false, 'invalid-slug'],
    ['qualified', true, undefined],
    ['reviewer', true, undefined],
  ]);

  const read = await client.library.read({ path: entrypoint, locationId: 'mango-skills', pathEnv });
  expect(read).toEqual({ content: skillText, truncated: false, sizeBytes: skillText.length });
  const outside = await client.library.read({
    path: join(directory, 'outside.md'),
    locationId: 'mango-skills',
    pathEnv,
  });
  expect(outside.denied).toBe(true);

  expect(
    await client.library.readTree({
      path: join(skills, 'qualified'),
      locationId: 'mango-skills',
      pathEnv,
    })
  ).toEqual({
    files: [{ relativePath: 'SKILL.md', contentBase64: Buffer.from(skillText).toString('base64') }],
  });

  const { locations } = await client.library.locations({ pathEnv });
  expect(locations.map((location) => location.id)).toEqual(
    LIBRARY_LOCATION_DEFINITIONS.map((location) => location.id)
  );
  expect(locations.find((location) => location.id === 'mango-skills')).toMatchObject({
    path: skills,
    exists: true,
    readable: true,
    entryCount: 2,
  });

  const sources = await client.library.settingsSources({ pathEnv });
  expect(sources.sources.map((source) => source.locationId)).toEqual([
    'mango-settings',
    'claude-settings',
    'claude-hooks',
    'codex-settings',
    'codex-hooks',
    'codex-permission-rules',
    'cursor-settings',
  ]);
  expect(typeof sources.homeDir).toBe('string');

  await assertRustRuntimeLibraryWrites(client, directory, pathEnv);
}

/**
 * The write lane and both directions of backup compatibility, against the
 * `qualified` skill {@link assertRustRuntimeLibraryMethods} left in place.
 */
async function assertRustRuntimeLibraryWrites(
  client: RuntimeClient,
  directory: string,
  pathEnv: { readonly env: Readonly<Record<string, string>> }
): Promise<void> {
  const skills = pathEnv.env.SKILLS_DIR ?? '';
  const backupRoot = join(directory, 'library-backups');
  const tsEnv = { platform: process.platform, homeDir: homedir(), env: { ...pathEnv.env } };
  const tsStore = createBackupStoreDeps({ backupRoot });
  const source = join(skills, 'qualified');
  const hash = await hashResourceAt(source, 'directory');
  const body = await readFile(join(source, 'SKILL.md'));

  // Rust writes a transferred tree; TypeScript reads the set it left.
  const applied = await client.library.apply({
    backupRoot,
    pathEnv,
    environmentId: 'rust-qualification',
    operations: [
      {
        resourceKey: 'skill:copied',
        locationId: 'mango-skills',
        slug: 'copied',
        operation: 'create',
        kind: 'directory',
        expectedContentHash: hash,
        destinationRoot: skills,
        files: [{ relativePath: 'SKILL.md', contentRef: 'skill' }],
      },
    ],
    contents: { skill: body.toString('base64') },
  });
  expect(applied.failed).toEqual([]);
  const applySet = applied.backupId ?? '';
  expect(await readBackupManifest(applySet, tsStore)).toMatchObject({
    version: 3,
    operation: 'propagation',
    environmentId: 'rust-qualification',
  });

  // Rust removes the original; TypeScript restores it from the Rust set.
  const removed = await client.library.remove({
    backupRoot,
    pathEnv,
    operations: [
      {
        resourceKey: 'skill:qualified',
        locationId: 'mango-skills',
        slug: 'qualified',
        kind: 'directory',
        expectedPath: source,
        expectedContentHash: hash,
        lastCopy: false,
      },
    ],
  });
  expect(removed.failed).toEqual([]);
  const removalSet = removed.backupId ?? '';
  expect((await client.library.backups({ backupRoot })).sets).toEqual(
    await listBackupSets(tsStore)
  );
  const restored = await executeLibraryUndo({ backupRoot, backupId: removalSet, pathEnv: tsEnv });
  expect(restored.restored.map((entry) => entry.locationId)).toEqual(['mango-skills']);
  expect(await hashResourceAt(source, 'directory')).toBe(hash);

  // TypeScript writes a set; Rust lists it and undoes it.
  const tsSet = '2026-09-23T10-15-44.087Z-00000000000000fe';
  const tsWrite = await executePropagationWrites({
    backupRoot,
    pathEnv: tsEnv,
    backupId: tsSet,
    operations: [
      {
        resourceKey: 'skill:from-ts',
        locationId: 'mango-skills',
        slug: 'from-ts',
        operation: 'create',
        kind: 'directory',
        expectedContentHash: hash,
        destinationRoot: skills,
        files: [{ relativePath: 'SKILL.md', contents: new Uint8Array(body) }],
      },
    ],
  });
  expect(tsWrite.failed).toEqual([]);
  const listed = await client.library.backups({ backupRoot });
  expect(listed.sets.find((set) => set.backupId === tsSet)).toMatchObject({
    operation: 'propagation',
    resourceKeys: ['skill:from-ts'],
    manifestReadable: true,
  });
  const undone = await client.library.undo({ backupRoot, backupId: tsSet, pathEnv });
  expect(undone.removed.map((entry) => entry.locationId)).toEqual(['mango-skills']);
  await expect(readFile(join(skills, 'from-ts', 'SKILL.md'))).rejects.toThrow();
  expect((await client.library.undo({ backupRoot, backupId: applySet, pathEnv })).removed).toEqual([
    { locationId: 'mango-skills', destinationPath: join(skills, 'copied') },
  ]);

  const missing = await rejectionOf(
    client.library.undo({ backupRoot, backupId: 'never-written', pathEnv })
  );
  expect((missing as RemoteError).details?.kind).toBe('library_backup_missing');
  expect(
    await client.library.gc({ backupRoot, purgeBackupIds: [applySet, removalSet, tsSet] })
  ).toEqual({ purged: [applySet, removalSet, tsSet], pruned: [] });
  expect(await client.library.backups({ backupRoot })).toEqual({ sets: [] });
}
