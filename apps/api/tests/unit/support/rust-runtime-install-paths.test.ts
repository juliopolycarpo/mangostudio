import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type WindowsInterpreter,
  writeFakeInstaller,
} from '../../support/rust-runtime-install-fixture';

const scratch: string[] = [];
const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Allocate a real host path that exercises both quoting and script-file decoding. */
async function fixtureDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fix-install-fixture-paths-'));
  scratch.push(root);
  const directory = join(root, "O'Brien O’Brien café 雪");
  await mkdir(directory);
  return directory;
}

/** Own each actual interpreter child until teardown, including failed script parses. */
function spawnControlled(argv: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn([...argv], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  children.push(child);
  return child;
}

async function collectControlled(child: ReturnType<typeof spawnControlled>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A named sleep fake makes the grandchild exit naturally after recording its actual argument. */
class FakeImmediateSleep {
  readonly marker: string;
  private readonly bin: string;
  constructor(directory: string) {
    this.marker = join(directory, 'sleep-arguments');
    this.bin = join(directory, 'bin');
  }
  async environment(): Promise<NodeJS.ProcessEnv> {
    await mkdir(this.bin);
    await writeFile(
      join(this.bin, 'sleep'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$FAKE_SLEEP_MARKER"\n',
      { mode: 0o755 }
    );
    return {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH}`,
      FAKE_SLEEP_MARKER: this.marker,
    };
  }
}

describe('controlled installer host paths', () => {
  it('executes an ordinary fixture path control', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fix-install-fixture-paths-control-'));
    scratch.push(directory);
    const installer = await writeFakeInstaller(directory, 'waits', 'ordinary');
    await writeFile(installer.release, '');
    const result = await collectControlled(spawnControlled(installer.argv));
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect((await readFile(installer.marker, 'utf8')).trim()).toBe('run');
  });

  const interpreters: WindowsInterpreter[] =
    process.platform === 'win32' ? ['powershell', 'cmd'] : ['powershell'];
  for (const interpreter of interpreters) {
    it.each(['waits', 'sleeps'] as const)(
      `executes ${process.platform === 'win32' ? interpreter : 'posix'} %s with apostrophe and Unicode paths`,
      async (mode) => {
        const directory = await fixtureDirectory();
        const installer = await writeFakeInstaller(directory, mode, 'install-café', interpreter);
        if (mode === 'waits') await writeFile(installer.release, '');
        const result = await collectControlled(spawnControlled(installer.argv));
        expect(
          result.exitCode,
          `expected valid host path script: exit 0 | received: ${JSON.stringify(result)}`
        ).toBe(0);
        expect(result.stdout).toContain('waiting');
        expect(result.stdout).toContain('done');
        expect(result.stderr).toContain('warn');
        expect((await readFile(installer.marker, 'utf8')).trim()).toBe('run');
      }
    );
  }

  it('renders PowerShell path literals with UTF-8 BOM for Windows PowerShell 5.1', async () => {
    const directory = await fixtureDirectory();
    const installer = await writeFakeInstaller(
      directory,
      'waits',
      "render's-café",
      'powershell',
      'win32'
    );
    const bytes = await readFile(installer.argv.at(-1) as string);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const source = bytes.toString('utf8');
    const pathData = [...source.matchAll(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/g)].map((match) =>
      Buffer.from(match[1] ?? '', 'base64').toString('utf8')
    );
    expect(pathData).toEqual([installer.release, installer.marker]);
    expect([...bytes.subarray(3)].every((byte) => byte < 128)).toBe(true);
    expect(source).not.toContain(directory);
    expect(source).toContain('[IO.File]::Exists($releasePath)');
    expect(source).toContain('[IO.File]::AppendAllText($markerPath,');
    expect(source).not.toMatch(/\b(?:Test-Path|Add-Content|Write-Output|Start-Sleep|Out-File)\b/);
  });

  it('keeps CMD source ASCII and derives Unicode filenames from its own script path', async () => {
    const directory = await fixtureDirectory();
    const installer = await writeFakeInstaller(directory, 'waits', "render's-café", 'cmd', 'win32');
    const bytes = await readFile(installer.argv.at(-1) as string);
    expect([...bytes].every((byte) => byte < 128)).toBe(true);
    const source = bytes.toString('ascii');
    expect(source).toContain('if exist "%~dpn0.release" goto go');
    expect(source).toContain('echo run>>"%~dpn0.marker"');
    expect(source).not.toContain(directory);
  });

  it.skipIf(process.platform !== 'win32')(
    'identifies native Windows PowerShell 5.1 for the Unicode controls',
    async () => {
      const result = await collectControlled(
        spawnControlled([
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::Write($PSVersionTable.PSVersion.ToString())',
        ])
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith('5.1.');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'records and reaps a grandchild using the apostrophe and Unicode pid path',
    async () => {
      const directory = await fixtureDirectory();
      const installer = await writeFakeInstaller(directory, 'grandchild', "tree's-café");
      const sleep = new FakeImmediateSleep(directory);
      const result = await collectControlled(
        spawnControlled(installer.argv, await sleep.environment())
      );
      expect(result.exitCode).toBe(0);
      expect(await readFile(sleep.marker, 'utf8')).toBe('30\n');
      const pidText = await readFile(installer.pidFile, 'utf8');
      expect(pidText).toMatch(/^\d+\n$/);
      const pid = Number(pidText.trim());
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      let missing: unknown;
      try {
        process.kill(pid, 0);
      } catch (error) {
        missing = error;
      }
      expect((missing as NodeJS.ErrnoException)?.code).toBe('ESRCH');
    }
  );

  it.each(['powershell', 'cmd'] as const)(
    'keeps %s grandchild mode POSIX-only',
    async (interpreter) => {
      await expect(
        writeFakeInstaller(await fixtureDirectory(), 'grandchild', 'rejected', interpreter, 'win32')
      ).rejects.toThrow('The grandchild installer is POSIX-only.');
    }
  );
});
