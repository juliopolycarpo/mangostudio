/**
 * On a case-insensitive volume (APFS default, casefold ext4, vfat) `realpathSync`
 * keeps the spelling it was given, so `/.BUILD-STATE.json` resolves to the private
 * build-state file under a name that differs from `BUILD_STATE_FILE` only in case.
 * The exact-name checks never match it, so the refusal has to fold case itself.
 *
 * Linux volumes here are case-sensitive, so the fixture stands in for one: symlinks
 * spelled in other cases point at the real file (a lookup under any spelling reaches
 * it), and a named fake `realpathSync` keeps the requested spelling instead of
 * following them, as the case-insensitive volume does.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { BUILD_STATE_FILE } from '@mangostudio/shared/utils/dist-files';
import { type AnyElysia, Elysia, NotFound } from 'elysia';

import type { App } from '../../../src/app';
import { clearFrontendFallback, frontendNotFound } from '../../../src/server/frontend-fallback';

const originalFs = { ...fs };
const realStatSync = fs.statSync;
const realRealpathSync = fs.realpathSync;
const PUBLIC_BODY = 'console.log("synthetic public asset")';
const PRIVATE_BODY = '{"apiUrl":"https://synthetic-private-case-variant.example.test"}';
const CASE_VARIANTS = ['.BUILD-STATE.json', '.Build-State.json'] as const;
const ALIAS_NAME = 'alias-CaseVar.json';

/** How the volume reports file IDs: usable ones, or none at all (FAT reports inode 0). */
type InodeReporting = 'real inode' | 'no inode';

let inodeReporting: InodeReporting = 'real inode';
let frontendDir: string;
let app: AnyElysia;
let origin: string;

/**
 * A case-insensitive volume's `realpathSync`: a case-variant of the build-state
 * name that exists comes back as spelled, instead of as the name stored on disk.
 */
function fakeCaseKeepingRealpathSync(...args: Parameters<typeof fs.realpathSync>): string {
  const path = String(args[0]);
  // A public-looking symlink whose target is spelled in another case resolves to
  // that spelling: the URL names no build state, only the resolved path does.
  if (basename(path) === ALIAS_NAME && originalFs.existsSync(path)) {
    return join(frontendDir, CASE_VARIANTS[0]);
  }
  if (
    (CASE_VARIANTS as readonly string[]).includes(basename(path)) &&
    originalFs.existsSync(path)
  ) {
    return path;
  }
  return realRealpathSync(...args) as string;
}

/** Real metadata, with every inode reported as 0 when the fixture volume has no file IDs. */
function fakeInodeReportingStatSync(
  ...args: Parameters<typeof fs.statSync>
): ReturnType<typeof fs.statSync> {
  const stats = realStatSync(...args);
  if (!stats || inodeReporting === 'real inode') return stats;
  const result = Object.create(stats) as typeof stats;
  Object.defineProperty(result, 'ino', { value: typeof stats.ino === 'bigint' ? 0n : 0 });
  return result;
}

/** A named filesystem fake; everything but realpath spelling and inode reporting stays real. */
function fakeCaseInsensitiveFs() {
  return {
    ...originalFs,
    realpathSync: fakeCaseKeepingRealpathSync,
    statSync: fakeInodeReportingStatSync,
  };
}

/** Restore the original filesystem exports after the case-variant tests. */
function originalFsModule() {
  return originalFs;
}

async function startServer(): Promise<void> {
  await mock.module('node:fs', fakeCaseInsensitiveFs);
  const { registerFrontend } = await import('../../../src/server/frontend-static');
  app = new Elysia().onError(NotFound, ({ request }) => frontendNotFound(request));
  registerFrontend(app as unknown as App, frontendDir);
  await app.modules;
  app.listen({ hostname: '127.0.0.1', port: 0, reusePort: false });
  origin = `http://127.0.0.1:${app.server?.port}`;
}

beforeEach(() => {
  // Canonical already, so the root is the same path before and after resolution.
  frontendDir = originalFs.realpathSync(originalFs.mkdtempSync(join(tmpdir(), 'frontend-case-')));
  originalFs.mkdirSync(join(frontendDir, 'assets'));
  originalFs.writeFileSync(join(frontendDir, 'index.html'), '<html>synthetic shell</html>');
  originalFs.writeFileSync(join(frontendDir, BUILD_STATE_FILE), PRIVATE_BODY);
  originalFs.writeFileSync(join(frontendDir, 'assets', 'index-CaseVar.js'), PUBLIC_BODY);
  // A case-sensitive volume needs a symlink per variant to stand in for a case-keeping one. On a
  // case-insensitive volume (NTFS, APFS by default) every variant already opens the file, and a
  // symlink beside it would collide with it.
  const volumeIgnoresCase = originalFs.existsSync(
    join(frontendDir, BUILD_STATE_FILE.toUpperCase())
  );
  if (!volumeIgnoresCase) {
    for (const variant of CASE_VARIANTS) {
      originalFs.symlinkSync(BUILD_STATE_FILE, join(frontendDir, variant));
    }
  }
  originalFs.symlinkSync(join('..', CASE_VARIANTS[0]), join(frontendDir, 'assets', ALIAS_NAME));
});

afterEach(async () => {
  if (app?.server) await app.stop();
  await mock.module('node:fs', originalFsModule);
  clearFrontendFallback();
  inodeReporting = 'real inode';
  originalFs.rmSync(frontendDir, { recursive: true, force: true });
});

const caseVariantUrls = [
  ...CASE_VARIANTS.map((variant) => `/${variant}`),
  // The percent-decoded form is what reaches the file lookup.
  '/%2EBUILD-STATE.json',
  '/.BUILD-STATE%2Ejson',
  '/%2e%42uild-State.json',
] as const;

for (const reporting of ['real inode', 'no inode'] as const) {
  describe(`build state under a case-keeping volume (${reporting})`, () => {
    beforeEach(async () => {
      inodeReporting = reporting;
      await startServer();
    });

    for (const method of ['GET', 'HEAD'] as const) {
      test(`${method} refuses every case-variant spelling of the build-state file`, async () => {
        for (const path of caseVariantUrls) {
          const response = await fetch(`${origin}${path}`, { method });
          const body = await response.text();
          expect(
            response.status,
            `${method} ${path} must not serve the build state; answered ${response.status} ${body}`
          ).toBe(404);
          expect(body).not.toContain(PRIVATE_BODY);
        }
      });
    }

    for (const method of ['GET', 'HEAD'] as const) {
      test(`${method} refuses a symlink whose realpath is a case-variant of the build state`, async () => {
        const response = await fetch(`${origin}/assets/${ALIAS_NAME}`, { method });
        const body = await response.text();
        expect(
          response.status,
          `${method} /assets/${ALIAS_NAME} resolves to the build state; answered ${response.status} ${body}`
        ).toBe(404);
        expect(body).not.toContain(PRIVATE_BODY);
      });
    }

    test('still serves public files, so the refusal is not a blanket 404', async () => {
      const response = await fetch(`${origin}/assets/index-CaseVar.js`);
      expect(await response.text()).toBe(PUBLIC_BODY);
    });
  });
}
