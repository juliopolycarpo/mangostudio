import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import turboConfigJson from '../../turbo.jsonc';
import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';

interface TurboConfig {
  readonly globalPassThroughEnv: readonly string[];
  readonly tasks: Record<string, { readonly env?: readonly string[] }>;
}

interface ProbeResult {
  readonly architecture: string | null;
  readonly powershell: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  } | null;
}

const turboConfig = turboConfigJson as TurboConfig;
const getPlatformFunction = readText('scripts/install/install.ps1').match(
  /^function Get-Platform \{[\s\S]*?^\}/m
)?.[0];

const CAPTURE_PROGRAM = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const architecture = process.env.PROCESSOR_ARCHITECTURE ?? null;
let powershell = null;
if (process.platform === 'win32') {
  const shell = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = Bun.spawnSync({
    cmd: [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', join(import.meta.dir, 'probe.ps1')],
    // Windows PowerShell answers in about 3 s with its analysis cache and 12 s or more without.
    timeout: 10000,
  });
  powershell = { exitCode: result.exitCode, stdout: result.stdout.toString(),
    stderr: result.stderr.toString() };
}
writeFileSync(join(import.meta.dir, 'metadata.json'), JSON.stringify({ architecture, powershell }));
`;

/** Owns an uncached workspace whose actual Turbo child runs the installer host probe. */
class StrictTurboHostFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'turbo-native-host-'));
  readonly probeDir = join(this.root, 'packages', 'probe');

  constructor(passThrough: readonly string[]) {
    mkdirSync(this.probeDir, { recursive: true });
    const packageManager = (JSON.parse(readText('package.json')) as { packageManager: string })
      .packageManager;
    writeFileSync(
      join(this.root, 'package.json'),
      JSON.stringify({
        name: 'turbo-native-host-fixture',
        private: true,
        packageManager,
        workspaces: ['packages/*'],
      })
    );
    writeFileSync(
      join(this.probeDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/native-host-probe',
        private: true,
        type: 'module',
        scripts: { capture: 'bun capture.ts' },
      })
    );
    // A dependency-free Bun workspace lock keeps the real Turbo graph deterministic.
    writeFileSync(
      join(this.root, 'bun.lock'),
      JSON.stringify({
        lockfileVersion: 2,
        configVersion: 1,
        workspaces: {
          '': { name: 'turbo-native-host-fixture' },
          'packages/probe': { name: '@fixture/native-host-probe' },
        },
        packages: {
          '@fixture/native-host-probe': ['@fixture/native-host-probe@workspace:packages/probe'],
        },
      })
    );
    writeFileSync(
      join(this.root, 'turbo.json'),
      JSON.stringify({
        ui: 'stream',
        agentGuidance: false,
        globalPassThroughEnv: passThrough,
        tasks: { capture: { cache: false, env: turboConfig.tasks['//#test:scripts']?.env } },
      })
    );
    expect(getPlatformFunction, 'expected the installer Get-Platform function').toBeDefined();
    writeFileSync(join(this.probeDir, 'capture.ts'), CAPTURE_PROGRAM);
    writeFileSync(
      join(this.probeDir, 'probe.ps1'),
      `$ErrorActionPreference = 'Stop'
function Fail([string]$Message) { throw $Message }
${getPlatformFunction}
$platform = Get-Platform
$archive = Get-Command Expand-Archive -ErrorAction Stop
@{ platform = $platform; archiveModule = $archive.ModuleName } | ConvertTo-Json -Compress
`
    );
  }

  async run(): Promise<ProbeResult> {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'x64' ? '64' : process.arch;
    const turboPackage = dirname(Bun.resolveSync('turbo/package.json', ROOT_DIR));
    const binary = Bun.resolveSync(
      `@turbo/${platform}-${arch}/bin/turbo${process.platform === 'win32' ? '.exe' : ''}`,
      turboPackage
    );
    const processHandle = Bun.spawn({
      cmd: [binary, 'run', 'capture', '--env-mode=strict'],
      cwd: this.root,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    expect(exitCode, `expected Turbo capture to pass: ${stdout}\n${stderr}`).toBe(0);
    return JSON.parse(readFileSync(join(this.probeDir, 'metadata.json'), 'utf8')) as ProbeResult;
  }

  dispose() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

describe('native host metadata in strict Turbo tasks', () => {
  it('preserves the inherited architecture for the installer and finds Expand-Archive', async () => {
    const fixture = new StrictTurboHostFixture(turboConfig.globalPassThroughEnv);
    try {
      const result = await fixture.run();

      expect(result.architecture).toBe(process.env.PROCESSOR_ARCHITECTURE ?? null);
      if (process.platform !== 'win32') return;
      expect(result.powershell?.exitCode, JSON.stringify(result)).toBe(0);
      expect(JSON.parse(result.powershell?.stdout ?? '')).toEqual({
        platform: process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64',
        archiveModule: 'Microsoft.PowerShell.Archive',
      });
    } finally {
      fixture.dispose();
    }
  }, 45_000);

  it('refuses an unknown platform when strict Turbo removes the architecture', async () => {
    const fixture = new StrictTurboHostFixture(
      turboConfig.globalPassThroughEnv.filter((name) => name !== 'PROCESSOR_ARCHITECTURE')
    );
    try {
      const result = await fixture.run();

      expect(result.architecture).toBeNull();
      if (process.platform !== 'win32') return;
      expect(result.powershell?.exitCode, JSON.stringify(result)).not.toBe(0);
      expect(result.powershell?.stderr, JSON.stringify(result)).toContain(
        'unsupported architecture'
      );
    } finally {
      fixture.dispose();
    }
  }, 45_000);
});
