/**
 * Records backup sets the real TypeScript write engines produce, for the Rust
 * runtime to list and undo — the TS→Rust half of the backup-compatibility
 * proof. `generate-library-fixtures.ts` embeds the result as the `backups`
 * section of the committed corpus.
 *
 * One store holds every case, written by `executePropagationWrites`,
 * `executeRemovalWrites` and `writeBackupManifest` with a fixed clock, fixed
 * set ids and fixed staging suffixes, so the output is deterministic. The
 * snapshot taken right after the writes is the input the Rust side replays;
 * the listing, each undo report and the tree after every undo are what TS
 * answered from that same snapshot. Absolute paths are recorded with the
 * scratch root as `<root>` and the separator as `<sep>`, so the Rust replay
 * can rebuild the manifests the way this platform would have written them.
 *
 * `hashes` pins `hashResourceAt` for ordinary documents — the digest apply
 * verifies with and undo compares with — so both runtimes are shown to agree
 * on normal content without depending on parser edge cases.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  createBackupStoreDeps,
  createLibraryUndoEngineDeps,
  createPropagationWriteEngineDeps,
  createRemovalWriteEngineDeps,
  createResourceWriterDeps,
  executeLibraryUndo,
  executePropagationWrites,
  executeRemovalWrites,
  hashResourceAt,
  listBackupSets,
  writeBackupManifest,
  writeDirectoryResource,
  writeFileResource,
} from '@mangostudio/shared/library/machine';

const NOW = new Date('2026-09-23T10:15:44.087Z');
const SKILL = '---\nname: gh\ndescription: GitHub\n---\n';
const SET_IDS = {
  propagation: '2026-09-23T10-15-44.087Z-00000000000000a1',
  transferred: '2026-09-23T10-15-44.087Z-00000000000000a2',
  removal: '2026-09-23T10-15-44.087Z-00000000000000a3',
  legacy: 'legacy-v1-set',
  uncommitted: 'uncommitted-set',
} as const;

interface TreeFile {
  readonly path: string;
  readonly base64: string;
}

function write(root: string, path: string, text: string): void {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/** Every regular file under `root`, posix-relative, sorted. */
function snapshot(root: string): TreeFile[] {
  const files: TreeFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files.push({
          path: relative(root, path).split(sep).join('/'),
          base64: readFileSync(path).toString('base64'),
        });
      }
    }
  };
  walk(root);
  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** `<root>`/`<sep>` templating for path strings and the manifests holding them. */
function template(text: string, root: string): string {
  return text.replaceAll(root, '<root>').replaceAll(sep, '<sep>');
}

function templateJson<T>(value: T, root: string): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'string' ? template(item, root) : item))
  );
}

function suffixes(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return next.toString(16).padStart(16, '0');
  };
}

export async function recordBackupCorpus(): Promise<unknown> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mango-backup-fixture-')));
  try {
    return await record(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function record(root: string): Promise<unknown> {
  const home = join(root, 'home');
  const backupRoot = join(root, 'backups');
  const env = { platform: process.platform, homeDir: home, env: {} } as const;
  write(home, '.claude/skills/gh/SKILL.md', `${SKILL}old body\n`);
  write(home, '.claude/skills/gh/refs/old.md', 'old reference\n');
  write(home, '.mango/skills/gh/SKILL.md', `${SKILL}mango body\n`);
  write(home, '.mango/skills/gh/nested/deep/a.md', 'deep\n');
  write(home, '.claude/agents/reviewer.md', '---\nname: Reviewer\n---\nReview.\n');
  write(home, '.codex/AGENTS.md', 'legacy instructions\n');
  write(root, 'source/gh/SKILL.md', `${SKILL}new body\n`);
  write(root, 'source/gh/refs/new.md', 'new reference\n');

  const hashes = [
    { kind: 'file', path: '.claude/agents/reviewer.md' },
    { kind: 'directory', path: '.claude/skills/gh' },
    { kind: 'directory', path: '.mango/skills/gh' },
  ] as const;
  const recordedHashes = await Promise.all(
    hashes.map(async (entry) => ({
      ...entry,
      contentHash: await hashResourceAt(join(home, ...entry.path.split('/')), entry.kind),
    }))
  );

  const randomSuffix = suffixes();
  const backup = createBackupStoreDeps({ backupRoot, now: () => NOW, randomSuffix });
  const writer = createResourceWriterDeps({ backupRoot, now: () => NOW, randomSuffix });
  const applyDeps = createPropagationWriteEngineDeps(
    { backupRoot },
    {
      backup,
      writeDirectory: (input) => writeDirectoryResource(input, writer),
      writeFile: (input) => writeFileResource(input, writer),
    }
  );
  const sourceDir = join(root, 'source', 'gh');
  const instructions = 'Created by the propagation fixture.\n';

  const propagation = await executePropagationWrites(
    {
      backupRoot,
      pathEnv: env,
      backupId: SET_IDS.propagation,
      environmentId: 'remote-box',
      operations: [
        {
          resourceKey: 'skill:gh',
          locationId: 'claude-skills',
          slug: 'gh',
          operation: 'overwrite',
          kind: 'directory',
          expectedContentHash: await hashResourceAt(sourceDir, 'directory'),
          destinationRoot: join(home, '.claude', 'skills'),
          sourceDir,
        },
        {
          resourceKey: 'instruction:global',
          locationId: 'claude-instructions',
          slug: 'global',
          operation: 'create',
          kind: 'file',
          expectedContentHash: await hashFileText(root, instructions),
          destinationRoot: join(home, '.claude', 'CLAUDE.md'),
          contents: new TextEncoder().encode(instructions),
        },
      ],
    },
    applyDeps
  );

  const transferredFiles = [
    { relativePath: 'SKILL.md', contents: new TextEncoder().encode(`${SKILL}transferred\n`) },
    { relativePath: 'refs/one.md', contents: new TextEncoder().encode('one\n') },
  ];
  const transferredSource = join(root, 'transferred-source');
  for (const file of transferredFiles) {
    write(transferredSource, file.relativePath, new TextDecoder().decode(file.contents));
  }
  const transferred = await executePropagationWrites(
    {
      backupRoot,
      pathEnv: env,
      backupId: SET_IDS.transferred,
      operations: [
        {
          resourceKey: 'skill:gh',
          locationId: 'mango-skills',
          slug: 'gh',
          operation: 'overwrite',
          kind: 'directory',
          expectedContentHash: await hashResourceAt(transferredSource, 'directory'),
          destinationRoot: join(home, '.mango', 'skills'),
          files: transferredFiles,
        },
      ],
    },
    applyDeps
  );

  const reviewer = join(home, '.claude', 'agents', 'reviewer.md');
  const removal = await executeRemovalWrites(
    {
      backupRoot,
      pathEnv: env,
      backupId: SET_IDS.removal,
      lastCopyResourceKeys: ['subagent:reviewer'],
      operations: [
        {
          resourceKey: 'subagent:reviewer',
          locationId: 'claude-agents',
          slug: 'reviewer',
          kind: 'file',
          expectedPath: reviewer,
          expectedContentHash: await hashResourceAt(reviewer, 'file'),
          lastCopy: true,
        },
      ],
    },
    createRemovalWriteEngineDeps({ backupRoot }, { backup })
  );

  // A v1 manifest as the first release wrote it: no operation, no resource
  // keys. Its copy sits where `backupExistingResource` would have put it.
  const legacyTarget = join(home, '.codex', 'AGENTS.md');
  const legacyCopy = join(backupRoot, SET_IDS.legacy, 'codex-instructions', 'global');
  mkdirSync(dirname(legacyCopy), { recursive: true });
  writeFileSync(legacyCopy, readFileSync(legacyTarget));
  const legacyHash = await hashResourceAt(legacyTarget, 'file');
  rmSync(legacyTarget);
  await writeBackupManifest(
    {
      version: 1,
      backupId: SET_IDS.legacy,
      createdAtMs: NOW.getTime() - 86_400_000,
      entries: [
        {
          locationId: 'codex-instructions',
          slug: 'global',
          kind: 'file',
          destinationPath: legacyTarget,
          resolvedPath: legacyTarget,
          backupPath: legacyCopy,
          writtenContentHash: legacyHash,
        },
      ],
    },
    backup
  );

  // A set whose manifest was never written: an apply still in flight, or the
  // only copy a failed commit left. Retention must list it and never evict it.
  write(backupRoot, `${SET_IDS.uncommitted}/claude-skills/gh/SKILL.md`, `${SKILL}in flight\n`);

  // Listing order is by set mtime; pin it so the corpus is deterministic.
  const order = [
    SET_IDS.uncommitted,
    SET_IDS.legacy,
    SET_IDS.propagation,
    SET_IDS.transferred,
    SET_IDS.removal,
  ];
  order.forEach((id, index) => {
    const seconds = 1_790_000_000 + index * 60;
    utimesSync(join(backupRoot, id), seconds, seconds);
  });
  const setMtimesMs = Object.fromEntries(
    order.map((id) => [id, statSync(join(backupRoot, id)).mtimeMs])
  );

  const afterWrites = snapshot(root);
  const listing = (
    await listBackupSets(createBackupStoreDeps({ backupRoot, retentionCount: 2 }))
  ).map(({ sizeBytes, ...set }) => ({
    ...set,
    // The manifest's own bytes embed the scratch path, so they are compared
    // separately; everything else a set holds is fixed by this script.
    sizeBytesWithoutManifest: sizeBytes - manifestSize(join(backupRoot, set.backupId)),
  }));

  const undoDeps = createLibraryUndoEngineDeps({ backupRoot }, { backup });
  const undos = [];
  for (const backupId of [
    SET_IDS.removal,
    SET_IDS.transferred,
    SET_IDS.propagation,
    SET_IDS.legacy,
  ]) {
    const report = await executeLibraryUndo({ backupRoot, backupId, pathEnv: env }, undoDeps);
    undos.push({ backupId, report: templateJson(report, root) });
  }
  const afterUndo = snapshot(home).map((file) => ({ ...file, path: `home/${file.path}` }));

  return {
    note: 'Written by the TypeScript engines; replayed by crates/mangostudio-runtime/src/library/mutation/ts_backup_compat_tests.rs.',
    results: templateJson({ propagation, transferred, removal }, root),
    setMtimesMs,
    afterWrites: afterWrites.map((file) =>
      file.path.endsWith('manifest.json')
        ? {
            path: file.path,
            template: template(Buffer.from(file.base64, 'base64').toString('utf8'), root),
          }
        : file
    ),
    listing: { retentionCount: 2, sets: listing },
    undos,
    afterUndo,
    hashes: recordedHashes,
  };
}

function manifestSize(setPath: string): number {
  const manifest = join(setPath, 'manifest.json');
  return existsSync(manifest) ? statSync(manifest).size : 0;
}

async function hashFileText(root: string, text: string): Promise<string> {
  const path = join(root, 'hash-input.md');
  writeFileSync(path, text);
  const hash = await hashResourceAt(path, 'file');
  rmSync(path);
  return hash;
}
