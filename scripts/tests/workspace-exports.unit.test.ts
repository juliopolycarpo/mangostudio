import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT_DIR } from '../lib/config';
import { bundleBinarySmoke } from '../release/bundle-binary-smoke';
import { readText } from './support/read-text';
import { walkRuntimeImports } from './support/runtime-imports';

const FAKE_SERVER_SPECIFIER = '@mangostudio/api/test-support/chatgpt/fake-server';
const FAKE_SERVER_EXPORT = './test-support/chatgpt/fake-server';
const FAKE_SERVER_TARGET = './tests/support/chatgpt/fake-server.ts';
const fixtureRoots: string[] = [];

/** Copy the actual smoke import graph into a checkout with no installed packages. */
function copySmokeFixture(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'mangostudio-no-install-smoke-'));
  fixtureRoots.push(fixtureRoot);
  const files = new Set([
    ...walkRuntimeImports('scripts/test-build.ts').files,
    ...['package.json', 'tsconfig.json', 'scripts/tsconfig.json', 'apps/api/package.json'].map(
      (file) => join(ROOT_DIR, file)
    ),
  ]);
  for (const file of files) {
    const target = join(fixtureRoot, relative(ROOT_DIR, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  return fixtureRoot;
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('root tooling workspace exports', () => {
  test('declares the API workspace that owns the build-smoke fixture', () => {
    const manifest = JSON.parse(readText('package.json')) as {
      devDependencies?: Record<string, string>;
    };
    const received = manifest.devDependencies?.['@mangostudio/api'];

    expect(
      received,
      `root tooling imports ${FAKE_SERVER_SPECIFIER} | expected package.json devDependencies["@mangostudio/api"] = "workspace:*" | received: ${JSON.stringify(received)}`
    ).toBe('workspace:*');
  });

  test('exports only the original ChatGPT fake server as API test support', () => {
    const manifest = JSON.parse(readText('apps/api/package.json')) as {
      exports?: Record<string, unknown>;
    };
    const received = Object.fromEntries(
      Object.entries(manifest.exports ?? {}).filter(([key]) => key.startsWith('./test-support'))
    );

    expect(
      received,
      `API test support must expose one deliberate file export | expected: ${FAKE_SERVER_EXPORT} -> ${FAKE_SERVER_TARGET} | received: ${JSON.stringify(received)}`
    ).toEqual({ [FAKE_SERVER_EXPORT]: FAKE_SERVER_TARGET });
  });

  test('pins the no-install smoke alias to the same exact API export target', () => {
    const config = JSON.parse(readText('scripts/tsconfig.json')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    const received = Object.fromEntries(
      Object.entries(config.compilerOptions?.paths ?? {}).filter(([key]) =>
        key.startsWith('@mangostudio/api')
      )
    );

    expect(
      received,
      `prebuilt smoke runs without node_modules | expected one exact ${FAKE_SERVER_SPECIFIER} alias to ../apps/api/${FAKE_SERVER_TARGET.slice(2)}, matching the API export | received: ${JSON.stringify(received)}`
    ).toEqual({ [FAKE_SERVER_SPECIFIER]: [`../apps/api/${FAKE_SERVER_TARGET.slice(2)}`] });
  });

  test('resolves the installed package export to the original file without script aliases', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--no-install',
        '-e',
        `console.log(import.meta.resolve('${FAKE_SERVER_SPECIFIER}'));`,
      ],
      cwd: ROOT_DIR,
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode, `expected root package export resolution | received: ${output}`).toBe(
      0
    );
    expect(realpathSync(fileURLToPath(result.stdout.toString().trim()))).toBe(
      realpathSync(join(ROOT_DIR, 'apps/api', FAKE_SERVER_TARGET))
    );
  });

  test('runs the exported named fake through real HTTP and awaits listener cleanup', async () => {
    const { FakeChatGptServer, startFakeChatGptServer } =
      await import('@mangostudio/api/test-support/chatgpt/fake-server');
    const fakeChatGpt = startFakeChatGptServer({ models: ['root-smoke-model'] });
    try {
      expect(fakeChatGpt).toBeInstanceOf(FakeChatGptServer);
      const models = await fetch(`${fakeChatGpt.apiBaseUrl}/models`);
      expect(models.status).toBe(200);
      expect(await models.json()).toEqual({ models: ['root-smoke-model'] });
      const token = await fetch(`${fakeChatGpt.authBaseUrl}/oauth/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'authorization_code', code: 'root-smoke-code' }),
      });
      expect(token.status).toBe(200);
      expect(await token.json()).toMatchObject({ refresh_token: fakeChatGpt.initialRefreshToken });
      expect(fakeChatGpt.tokenRequests).toEqual([
        { grantType: 'authorization_code', code: 'root-smoke-code', refreshToken: null },
      ]);
    } finally {
      await fakeChatGpt.server.stop(true);
    }
  });

  test.each(process.platform === 'win32' ? [false] : [false, true])(
    'runs the bundled build-smoke with no packages or source tree and resolves the checkout root (alias=%s)',
    async (alias) => {
      const bundle = await bundleBinarySmoke();
      const physicalRoot = mkdtempSync(join(tmpdir(), 'ci-native-hub-producers-bundle-'));
      fixtureRoots.push(physicalRoot);
      const fixtureRoot = alias ? `${physicalRoot}-alias` : physicalRoot;
      if (alias) {
        symlinkSync(physicalRoot, fixtureRoot);
        fixtureRoots.unshift(fixtureRoot);
      }
      const fixtureBundle = join(fixtureRoot, '.mango', 'smoke', 'test-build.mjs');
      mkdirSync(dirname(fixtureBundle), { recursive: true });
      copyFileSync(bundle, fixtureBundle);
      writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ version: '8.7.6' }));
      const env = { ...process.env };
      delete env.VERSION;
      delete env.DISTRIBUTION_MANIFEST_PATH;
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--no-install', fixtureBundle],
        cwd: tmpdir(),
        env: {
          ...env,
          PLATFORM: 'linux-x64-musl',
          SKIP_BUILD: '1',
          SOURCE_SHA: 'synthetic-source',
          DISTRIBUTION_CHANNEL: 'test',
        },
      });
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      expect(existsSync(join(fixtureRoot, 'node_modules'))).toBe(false);
      expect(existsSync(join(fixtureRoot, 'apps'))).toBe(false);
      expect(existsSync(join(fixtureRoot, 'scripts'))).toBe(false);
      expect(result.exitCode, output).toBe(1);
      expect(
        output,
        'expected intended artifact validation after successful bundled imports'
      ).toContain('Missing distribution manifest');
      const manifestPath = output.match(/Missing distribution manifest: ([^\r\n]+)/)?.[1];
      expect(manifestPath, output).toBeDefined();
      expect(basename(manifestPath as string)).toBe('distribution-manifest.json');
      expect(realpathSync(dirname(manifestPath as string))).toBe(realpathSync(fixtureRoot));
      expect(output).toContain('platform: linux-x64-musl');
      expect(output).not.toContain('Cannot find module');
      expect(output).not.toContain('Building binary');
    }
  );

  test('runs the same fake-server export without installed packages', () => {
    const fixtureRoot = copySmokeFixture();
    writeFileSync(
      join(fixtureRoot, 'scripts', 'fake-server-smoke.ts'),
      `import { startFakeChatGptServer } from '${FAKE_SERVER_SPECIFIER}';
const fakeChatGpt = startFakeChatGptServer({ models: ['no-install-smoke'] });
try {
  const response = await fetch(fakeChatGpt.apiBaseUrl + '/models');
  console.log(JSON.stringify({ status: response.status, body: await response.json() }));
} finally {
  await fakeChatGpt.server.stop(true);
}
`
    );
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--no-install', 'run', 'scripts/fake-server-smoke.ts'],
      cwd: fixtureRoot,
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode, `expected exported fake-server HTTP smoke | received: ${output}`).toBe(
      0
    );
    expect(JSON.parse(result.stdout.toString())).toEqual({
      status: 200,
      body: { models: ['no-install-smoke'] },
    });
    expect(existsSync(join(fixtureRoot, 'node_modules'))).toBe(false);
  });
});
