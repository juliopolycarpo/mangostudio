import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

const scratchRoots: string[] = [];
const spawnedServers = new Set<number>();

afterEach(() => {
  for (const pid of spawnedServers) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  spawnedServers.clear();
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stageBuildSmoke(executable = true): Promise<{
  script: string;
  eventsPath: string;
  tempDir: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'mango-build-smoke-cleanup-'));
  scratchRoots.push(root);
  const scripts = join(root, 'scripts');
  const target = join(root, '.mango', 'out', 'linux-x64');
  const tempDir = join(root, 'temp');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(target, { recursive: true });
  mkdirSync(tempDir);
  symlinkSync(join(ROOT_DIR, 'scripts', 'lib'), join(scripts, 'lib'), 'dir');
  symlinkSync(join(ROOT_DIR, 'scripts', 'release'), join(scripts, 'release'), 'dir');
  symlinkSync(join(ROOT_DIR, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}');

  const callbackReservation = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(),
  });
  const callbackPort = callbackReservation.port;
  await callbackReservation.stop(true);
  const source = readText('scripts/test-build.ts').replace(
    'const CHATGPT_CALLBACK_PORT = 1455;',
    `const CHATGPT_CALLBACK_PORT = ${callbackPort};`
  );
  const mainOffset = source.indexOf('// Main\n');
  expect(mainOffset).toBeGreaterThan(0);
  // Isolate the real foreground smoke without synthesizing distribution,
  // installer and runtime artifacts. Keep the actual CLI's catch, fail() and
  // foreground setup/finally intact, with a private callback probe port.
  const main = source.slice(mainOffset);
  const tryOffset = main.indexOf('\ntry {\n');
  const catchOffset = main.indexOf('} catch (caught) {');
  expect(tryOffset).toBeGreaterThan(0);
  expect(catchOffset).toBeGreaterThan(tryOffset);
  const script = join(scripts, 'test-build.ts');
  writeFileSync(
    script,
    `${source.slice(0, mainOffset)}${main.slice(0, tryOffset)}\ntry {\n  await smokeTest();\n${main.slice(catchOffset)}`
  );
  const binary = join(target, 'mangostudio');
  writeFileSync(
    binary,
    `#!${process.execPath}\n${readText('scripts/tests/support/fake-build-smoke-server.ts')}`
  );
  chmodSync(binary, executable ? 0o755 : 0o644);
  return { script, eventsPath: join(root, 'events.jsonl'), tempDir };
}

describe('test-build foreground server cleanup', () => {
  test.skipIf(process.platform === 'win32')(
    'a failed first HTTP assertion exits nonzero only after its server stops and releases the port',
    async () => {
      const { script, eventsPath, tempDir } = await stageBuildSmoke();
      const reservation = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: () => new Response(),
      });
      const port = reservation.port;
      await reservation.stop(true);
      const smoke = Bun.spawn([process.execPath, script], {
        env: {
          ...process.env,
          API_PORT: String(port),
          FAKE_BUILD_SMOKE_EVENTS: eventsPath,
          PLATFORM: 'linux-x64',
          VERSION: '1.2.3',
          TMPDIR: tempDir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(smoke.stdout).text(),
        new Response(smoke.stderr).text(),
        smoke.exited,
      ]);
      const events = readFileSync(eventsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event: string; pid: number });
      const startup = events.find(({ event }) => event === 'startup');
      expect(startup, `${stdout}${stderr}`).toBeDefined();
      if (!startup) throw new Error(`Expected the fake hub to start; output: ${stdout}${stderr}`);
      spawnedServers.add(startup.pid);
      expect(code, `${stdout}${stderr}`).toBe(1);
      expect(stderr).toContain('/api/health content-type is not JSON');
      expect(isAlive(startup.pid), 'failed binary smoke left its foreground hub running').toBe(
        false
      );
      expect(events.map(({ event }) => event)).toEqual(['startup', 'sigterm', 'exit']);
      expect(readdirSync(tempDir)).toEqual([]);

      const nextServer = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response() });
      await nextServer.stop(true);
    },
    15_000
  );

  test.skipIf(process.platform === 'win32')(
    'a synchronous hub spawn failure closes the fake ChatGPT listener and removes its home before the CLI exits',
    async () => {
      const { script, eventsPath, tempDir } = await stageBuildSmoke(false);
      const smoke = Bun.spawn([process.execPath, script], {
        env: {
          ...process.env,
          FAKE_BUILD_SMOKE_EVENTS: eventsPath,
          PLATFORM: 'linux-x64',
          VERSION: '1.2.3',
          TMPDIR: tempDir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5_000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(smoke.stdout).text(),
        new Response(smoke.stderr).text(),
        smoke.exited,
      ]);
      expect(stdout).toContain('Starting binary on port');
      expect(stderr).toContain('EACCES: permission denied');
      expect(
        code,
        `CLI exited ${code} (${smoke.signalCode}) after EACCES; expected exit 1 after listener cleanup. Output:\n${stdout}${stderr}`
      ).toBe(1);
      expect(readdirSync(tempDir)).toEqual([]);
    },
    10_000
  );
});
