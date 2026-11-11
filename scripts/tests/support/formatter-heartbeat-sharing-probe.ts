import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GRANDCHILD_ENV,
  HANG_ENV,
  heartbeatPath,
  MARKER_ENV,
  stopPath,
} from './fake-rustfmt-markers';

const lockScript = [
  '$ErrorActionPreference = "Stop"',
  '$stream = $null',
  'for ($attempt = 0; $attempt -lt 100 -and $null -eq $stream; $attempt++) {',
  '  try {',
  '    $stream = [System.IO.File]::Open($env:MANGO_SHARING_TARGET, "Open", "Read", "ReadWrite")',
  '  } catch [System.IO.IOException] { Start-Sleep -Milliseconds 10 }',
  '}',
  'if ($null -eq $stream) { throw "expected a locked heartbeat | received: no file handle" }',
  'try {',
  '  [System.IO.File]::WriteAllText($env:MANGO_SHARING_READY, "locked")',
  '  while (-not [System.IO.File]::Exists($env:MANGO_SHARING_RELEASE)) { Start-Sleep -Milliseconds 10 }',
  '} finally { $stream.Dispose() }',
].join('\n');

async function waitFor(predicate: () => Promise<boolean>, expected: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`expected ${expected} within 3000ms | received: no event`);
}

const root = await mkdtemp(join(tmpdir(), 'mango-formatter-sharing-'));
const executable = join(root, 'rustfmt.exe');
const marker = join(root, 'started.json');
const heartbeat = heartbeatPath(marker);
const ready = join(root, 'sharing-ready');
const release = join(root, 'sharing-release');
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, 'fake-rustfmt.ts')],
  compile: { outfile: executable },
});
if (!build.success) throw new Error('expected compiled fake rustfmt | received: build failure');
const child = Bun.spawn([executable], {
  env: { ...process.env, [MARKER_ENV]: marker, [HANG_ENV]: '1', [GRANDCHILD_ENV]: '1' },
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'pipe',
  timeout: 15_000,
});
const childError = child.stderr.text();

try {
  await waitFor(() => Bun.file(heartbeat).exists(), 'an initial heartbeat');
  const locker = Bun.spawn(['pwsh.exe', '-NoProfile', '-NonInteractive', '-Command', lockScript], {
    env: {
      ...process.env,
      MANGO_SHARING_TARGET: heartbeat,
      MANGO_SHARING_READY: ready,
      MANGO_SHARING_RELEASE: release,
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 10_000,
  });
  const lockError = locker.stderr.text();

  try {
    await waitFor(
      () => Bun.file(ready).exists(),
      'a Windows read handle that omits delete sharing'
    );
    const locked = await readFile(heartbeat, 'utf8');
    console.log(`Heartbeat under lock: ${locked}`);
    await Bun.sleep(400);
    if (child.exitCode !== null) {
      throw new Error(
        `expected the heartbeat publisher to remain alive during replacement contention | received exit ${
          child.exitCode
        }\n${await childError}`
      );
    }

    await writeFile(release, '');
    if ((await locker.exited) !== 0) throw new Error(await lockError);
    await waitFor(
      async () => (await readFile(heartbeat, 'utf8')) !== locked,
      'heartbeat progress after release'
    );
    console.log(`Heartbeat after release: ${await readFile(heartbeat, 'utf8')}`);
  } finally {
    await writeFile(release, '');
    await locker.exited;
  }
} finally {
  await writeFile(stopPath(marker), '');
  await child.exited;
  await rm(root, { recursive: true, force: true });
}
