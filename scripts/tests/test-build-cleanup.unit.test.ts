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
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { assertSignalablePid, signalPid } from './support/signal-pid';
import {
  describePortHolder,
  describeSmokeStall,
  readTimedText,
  type SmokeEvent,
} from './support/smoke-stall-report';

const scratchRoots: string[] = [];
const spawnedServers = new Set<number>();

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  const pids = [...spawnedServers];
  spawnedServers.clear();
  // signalPid refuses pid 0 (this test's own group) and 1: `isAlive(0)` is true.
  for (const pid of pids) if (isAlive(pid)) signalPid(pid, 'SIGKILL');
});

/**
 * The fake hub's event log; empty when the hub never ran its first line, which
 * is itself evidence {@link describeSmokeStall} names.
 */
function readSmokeEvents(eventsPath: string): SmokeEvent[] {
  let raw: string;
  try {
    raw = readFileSync(eventsPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as SmokeEvent);
}

describe('readSmokeEvents', () => {
  test('a missing events file reads as no events', () => {
    expect(readSmokeEvents(join(tmpdir(), 'mango-build-smoke-absent', 'events.jsonl'))).toEqual([]);
  });

  test('parses one event per line', () => {
    const root = mkdtempSync(join(tmpdir(), 'mango-build-smoke-events-'));
    scratchRoots.push(root);
    const eventsPath = join(root, 'events.jsonl');
    writeFileSync(eventsPath, '{"event":"startup","pid":7}\n{"event":"exit","pid":7}\n');
    expect(readSmokeEvents(eventsPath)).toEqual([
      { event: 'startup', pid: 7 },
      { event: 'exit', pid: 7 },
    ]);
  });
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
  const original = readText('scripts/test-build.ts');
  const source = original
    .replace(
      'const CHATGPT_CALLBACK_PORT = 1455;',
      `const CHATGPT_CALLBACK_PORT = ${callbackPort};`
    )
    .replace(
      "import { ROOT_DIR } from './lib/config';",
      `const ROOT_DIR = ${JSON.stringify(root)};`
    );
  // An unmatched replace would leave the smoke probing the real callback port.
  expect(source, 'expected test-build.ts to declare CHATGPT_CALLBACK_PORT = 1455').not.toBe(
    original
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
    `#!${process.execPath}\n${readText('scripts/tests/support/fake-build-smoke-server.ts').replace('process.env.FAKE_BUILD_SMOKE_EVENTS', JSON.stringify(join(root, 'events.jsonl')))}`
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
      const port = reservation.port as number;
      await reservation.stop(true);
      const spawnedAt = performance.now();
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
      const [out, err, code] = await Promise.all([
        readTimedText(smoke.stdout, spawnedAt),
        readTimedText(smoke.stderr, spawnedAt),
        smoke.exited,
      ]);
      const elapsedMs = performance.now() - spawnedAt;
      const stdout = out.text;
      const stderr = err.text;
      const events = readSmokeEvents(eventsPath);
      const startup = events.find(({ event }) => event === 'startup');
      if (!startup) {
        // A script killed by its spawn timeout (#2762) explains itself here: the
        // stage it reached, when it first spoke, who holds the port and the load.
        const firstChunks = [out, err].flatMap(({ firstChunkMs }) =>
          firstChunkMs === null ? [] : [firstChunkMs]
        );
        throw new Error(
          describeSmokeStall({
            code,
            signal: smoke.signalCode,
            elapsedMs,
            firstOutputMs: firstChunks.length > 0 ? Math.min(...firstChunks) : null,
            stdout,
            stderr,
            events,
            port,
            portState: describePortHolder(port),
            load: loadavg(),
          })
        );
      }
      spawnedServers.add(assertSignalablePid(startup.pid));
      expect(code, `${stdout}${stderr}`).toBe(1);
      expect(stderr).toContain('/api/health content-type is not JSON');
      // An assertion verdict names itself; a stack would bury it in the CI log.
      expect(stderr, 'assertion verdicts print without a stack').not.toMatch(/\n\s+at /);
      expect(isAlive(startup.pid), 'failed binary smoke left its foreground hub running').toBe(
        false
      );
      expect(events.map(({ event }) => event)).toEqual(['boot', 'startup', 'sigterm', 'exit']);
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
      // Unexpected errors carry no assertion text, so the stack is the only
      // thing naming the smoke stage that threw.
      const frame = /\n\s+at smokeTest /.exec(stderr)?.[0].trim() ?? 'no stack frame';
      expect(
        frame,
        `expected unexpected-error stack frame: at smokeTest | received: ${frame}`
      ).toBe('at smokeTest');
      expect(
        code,
        `CLI exited ${code} (${smoke.signalCode}) after EACCES; expected exit 1 after listener cleanup. Output:\n${stdout}${stderr}`
      ).toBe(1);
      expect(readdirSync(tempDir)).toEqual([]);
    },
    10_000
  );
});
