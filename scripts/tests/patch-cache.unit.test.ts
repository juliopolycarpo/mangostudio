import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { turboDryRun } from './support/turbo-run';

const PATCH_PATHS = Object.values(
  (JSON.parse(readText('package.json')) as { patchedDependencies: Record<string, string> })
    .patchedDependencies
);
const AFFECTED_TASKS = ['@mangostudio/api', '@mangostudio/frontend'].flatMap((workspace) =>
  ['build', 'typecheck', 'test:unit'].map((task) => `${workspace}#${task}`)
);

/** Copies the shipped Turbo configuration and Bun dependency graph without executing tasks. */
function createPatchFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mango-patch-cache-'));
  const workspaceFiles = new Bun.Glob('{apps,packages}/*/{package.json,turbo.json}').scanSync({
    cwd: ROOT_DIR,
  });
  const paths = [
    'package.json',
    'bun.lock',
    'turbo.jsonc',
    'tsconfig.json',
    '.gitattributes',
    ...workspaceFiles,
    ...PATCH_PATHS,
  ];
  for (const path of paths) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ROOT_DIR, path), destination);
  }
  return root;
}

/** Asserts the intended tasks exist before comparing the real Turbo cache keys. */
async function affectedHashes(root: string): Promise<Record<string, string>> {
  const tasks = await turboDryRun(root, ['run', 'build', 'typecheck', 'test:unit']);
  const hashes = Object.fromEntries(tasks.map((task) => [task.taskId, task.hash]));
  for (const taskId of AFFECTED_TASKS) {
    expect(hashes[taskId], `expected a cache key for ${taskId} | received: no task`).toBeDefined();
  }
  return Object.fromEntries(AFFECTED_TASKS.map((taskId) => [taskId, hashes[taskId] as string]));
}

describe('Bun patch inputs in Turbo cache keys', () => {
  test('keeps affected keys stable when no dependency input changes', async () => {
    const root = createPatchFixture();
    try {
      expect(await affectedHashes(root)).toEqual(await affectedHashes(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const patchPath of PATCH_PATHS) {
    test(`changes affected keys when only ${patchPath} bytes change`, async () => {
      const root = createPatchFixture();
      try {
        const before = await affectedHashes(root);
        const manifests = ['package.json', 'bun.lock'].map((path) =>
          readFileSync(join(root, path))
        );
        const path = join(root, patchPath);
        const original = readFileSync(path);
        // A trailing LF keeps the patch valid without changing its path, manifest or lockfile.
        writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
        const changed = await affectedHashes(root);
        for (const taskId of AFFECTED_TASKS) {
          expect(
            changed[taskId],
            `expected ${taskId} cache key to change after ${patchPath} bytes changed | received: unchanged ${before[taskId]}`
          ).not.toBe(before[taskId]);
        }
        expect(readFileSync(join(root, 'package.json'))).toEqual(manifests[0]);
        expect(readFileSync(join(root, 'bun.lock'))).toEqual(manifests[1]);
        writeFileSync(path, original);
        expect(await affectedHashes(root)).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
