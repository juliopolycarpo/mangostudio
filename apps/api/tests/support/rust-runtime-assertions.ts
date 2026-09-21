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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteError } from '@mangostudio/protocol';
import { rejectionOf } from '@mangostudio/protocol/testing';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-contract';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import type { RuntimeClient } from '../../src/services/runtime-client/runtime-client';

/** Node-style platform/arch this test process itself runs on, mirroring `health.rs`'s own mapping. */
function nodePlatform(): string {
  return process.platform;
}

/**
 * The exact `allow` object a freshly auto-granted slot with no stored
 * `runtime.json` reports — `consent::presets::FULL` on the Rust side,
 * granted either directly (a `host` slot's own default) or through
 * `consent_by_invocation`'s "invocation is consent" grant (a never-before-seen
 * `remote` slot, which `serve`/`connect` both use). Every capability this
 * crate's `RuntimeCapabilityAllowSchema` declares, all `true`.
 */
const FULL_ALLOW = {
  fsRead: true,
  fsWrite: true,
  shell: true,
  git: true,
  probing: true,
  mcp: true,
  library: true,
  checkpoints: true,
  update: true,
  externalAgents: true,
} as const;

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
  expect(health.platform).toBe(nodePlatform());
  expect(health.allow).toEqual(FULL_ALLOW);
  expect(health.profile).toBe('full');
  expect(health.setup?.state).toBe('configured');
  expect(typeof health.git.available).toBe('boolean');
  if (health.git.available) {
    expect(typeof health.git.version).toBe('string');
  }
  const expectedShell =
    process.platform === 'win32' ? 'powershell' : process.platform === 'darwin' ? 'zsh' : 'bash';
  expect(health.shells).toContain(expectedShell);
  expect(health.lastError ?? null).toBeNull();
}

/**
 * Pins the real Rust host's implementation ceiling while the foundation
 * intentionally implements only health, workspace, and probing methods.
 *
 * @example
 * assertRustRuntimeFeatureCeiling(client.manifest, { probing: true });
 */
export function assertRustRuntimeFeatureCeiling(
  manifest: RuntimeCapabilityManifest,
  expected: { readonly probing: boolean }
): void {
  expect(manifest.features).toEqual({
    tools: expected.probing,
    git: false,
    probing: expected.probing,
    mcp: false,
    library: false,
    checkpoints: false,
    fsRead: false,
    fsWrite: false,
    shell: false,
    update: false,
    externalAgents: false,
    toolchain: true,
  });
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
