#!/usr/bin/env bun

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { createTurboBuildCommand, selectBuildWorkspaces } from './lib/build';
import {
  bunCompiledRuntimes,
  bunCrossCompileChannel,
  clearBunCrossRuntimeCache,
  ensureBunCrossRuntime,
} from './lib/bun-cross-runtime';
import { ROOT_DIR, type WorkspaceName } from './lib/config';
import { writeEmbedModules } from './lib/embed-frontend';
import {
  ALL_BINARY_TARGETS,
  type BinaryTarget,
  filterBinaryTargets,
  runtimeBinaryName,
} from './lib/release-targets';
import { resolveReleaseVersion } from './lib/release-version';
import {
  assertNoUnexpectedArguments,
  captureCommand,
  fatal,
  header,
  parseArgs,
  runCommand,
  warn,
} from './lib/runner';

/** Runtime binary entrypoint; the hub embeds the same host for Local. */
const RUNTIME_ENTRY = join(ROOT_DIR, 'apps/runtime/src/cli.ts');

interface BinaryBuildOptions {
  buildType: 'production' | 'development';
  dryRun: boolean;
  onlyPlatform?: string;
  /** Discard the cached channel runtimes first, forcing a real download. */
  refreshRuntimes: boolean;
  version: string;
}

interface BuildStamp {
  gitSha: string;
  gitDirty: boolean | 'unknown';
  builtAt: string;
  buildType: string;
}

function printHelp(): never {
  console.log(`Usage: bun run build [workspace flags]
       bun run build --binary [--platform <target>] [--production | --development]

Default:
  Builds the frontend workspace.

Workspace flags:
  --frontend   Build the frontend workspace
  --api        Build the API workspace
  --runtime    Build the runtime library workspace
  --all        Build every build-capable workspace

Binary flags:
  --binary            Build standalone binaries into .mango/out
  --platform <id>     Limit binary output to one target (example: linux-x64)
  --production        Use production binary settings (default)
  --development       Use development binary settings
  --dry-run           Preview the build without writing artifacts
  --refresh-runtimes  Re-download the channel Bun runtimes instead of reusing the cache
  --help              Show this help message`);
  process.exit(0);
}

async function buildFrontendSidecar(dryRun: boolean): Promise<void> {
  console.log('🏗️  Ensuring frontend sidecar...');

  if (dryRun) {
    console.log('   (dry run) Would run turbo build for @mangostudio/frontend');
    console.log('✅ Frontend sidecar ready (dry run)');
    return;
  }

  const result = await runCommand('build:frontend', createTurboBuildCommand(['frontend']), {
    cwd: ROOT_DIR,
  });
  if (result.exitCode !== 0) {
    fatal('Frontend build failed during standalone binary packaging.');
  }
}

/**
 * Move `apps/frontend/dist` aside so the sidecar rebuild starts from nothing,
 * with a guarantee the previous bundle comes back if no new one is published.
 * A dev server may be serving that directory, and losing it to a failed build
 * is exactly what `publishDist` in `apps/frontend/build.ts` exists to prevent.
 *
 * `buildFrontendSidecar` reports failure through `fatal()` — `process.exit`,
 * not a throw — so the restore is armed on process exit as well as handed back
 * for the throwing path. A successful publish leaves a complete new `dist/`
 * (the frontend build swaps it in by rename), in which case restore keeps the
 * new one and drops the copy.
 */
function withFrontendDistAside(
  frontendDist: string,
  dryRun: boolean
): { restore(): void; discard(): void } {
  if (dryRun || !existsSync(frontendDist)) {
    // Nothing to set aside, so nothing to restore or discard.
    const noop = (): void => undefined;
    return { restore: noop, discard: noop };
  }
  const aside = `${frontendDist}.aside-${process.pid}`;
  rmSync(aside, { recursive: true, force: true });
  renameSync(frontendDist, aside);
  let settled = false;
  const restore = (): void => {
    if (settled) return;
    settled = true;
    process.off('exit', restore);
    if (existsSync(frontendDist)) {
      rmSync(aside, { recursive: true, force: true });
    } else {
      renameSync(aside, frontendDist);
    }
  };
  process.on('exit', restore);
  return {
    restore,
    discard(): void {
      if (settled) return;
      settled = true;
      process.off('exit', restore);
      rmSync(aside, { recursive: true, force: true });
    },
  };
}

/**
 * Compiles one entrypoint for one Bun target. The build stamp is applied to
 * both binaries so the hub and the runtime it spawns report the same release —
 * the protocol handshake refuses a mismatch.
 */
async function compileBinary(
  entry: string,
  target: BinaryTarget,
  outfile: string,
  options: BinaryBuildOptions,
  context: { buildTime: string; buildInfo: BuildStamp; crossRuntimePath?: string }
): Promise<boolean> {
  const args = [
    'build',
    entry,
    '--compile',
    '--target',
    target.target,
    '--outfile',
    outfile,
    '--define',
    `process.env.BUILD_TIME=${JSON.stringify(context.buildTime)}`,
    '--define',
    `process.env.BUILD_BUILT_AT=${JSON.stringify(context.buildInfo.builtAt)}`,
    '--define',
    `process.env.BUILD_GIT_SHA=${JSON.stringify(context.buildInfo.gitSha)}`,
    '--define',
    `process.env.BUILD_GIT_DIRTY=${JSON.stringify(String(context.buildInfo.gitDirty))}`,
    '--define',
    `process.env.BUILD_TYPE=${JSON.stringify(options.buildType)}`,
    '--define',
    `process.env.VERSION=${JSON.stringify(options.version)}`,
    '--define',
    'process.env.NODE_ENV="production"',
    '--sourcemap=external',
  ];

  if (options.buildType === 'production') {
    args.push('--minify');
  }

  // Supplying the target's Bun keeps `--compile` from resolving a download by
  // version, which no channel build can satisfy.
  if (context.crossRuntimePath) {
    args.push('--compile-executable-path', context.crossRuntimePath);
  }

  const { stdout, stderr, exitCode } = await captureCommand(['bun', ...args], { cwd: ROOT_DIR });

  if (exitCode !== 0) {
    console.error(`❌ Failed to build ${basename(outfile)} for ${target.arch}:`);
    if (stderr.trim()) console.error(stderr.trim());
    return false;
  }

  console.log(`✅ Successfully built ${basename(outfile)} for ${target.arch}`);
  if (stdout.trim()) console.log(stdout.trim());
  return true;
}

async function buildStandaloneTarget(
  target: BinaryTarget,
  options: BinaryBuildOptions,
  context: {
    apiSource: string;
    buildTime: string;
    buildInfo: BuildStamp;
    outDir: string;
    crossRuntimeChannel: string | null;
  }
): Promise<boolean> {
  const platformOutDir = join(context.outDir, target.arch);
  mkdirSync(platformOutDir, { recursive: true });

  const binaryPath = join(platformOutDir, target.name);
  const runtimeName = runtimeBinaryName(target.name);
  const runtimePath = join(platformOutDir, runtimeName);

  console.log(`🔨 Building for ${target.arch} (${target.target}) → ${binaryPath}`);

  if (options.dryRun) {
    console.log(`   (dry run) Would compile for ${target.target}`);
    console.log(`✅ Successfully built ${target.name} for ${target.arch} (dry run)`);
    console.log(`✅ Successfully built ${runtimeName} for ${target.arch} (dry run)`);
    return true;
  }

  let crossRuntimePath: string | undefined;
  if (context.crossRuntimeChannel) {
    try {
      crossRuntimePath = await ensureBunCrossRuntime(target, {
        channel: context.crossRuntimeChannel,
      });
      console.log(
        `   🥟 ${context.crossRuntimeChannel} Bun for ${target.arch}: ${crossRuntimePath}`
      );
    } catch (caught) {
      console.error(
        `❌ Failed to resolve a ${context.crossRuntimeChannel} Bun runtime for ${target.arch}: ${
          caught instanceof Error ? caught.message : String(caught)
        }`
      );
      return false;
    }
  }

  try {
    const compiled = await Promise.all([
      compileBinary(context.apiSource, target, binaryPath, options, {
        ...context,
        crossRuntimePath,
      }),
      compileBinary(RUNTIME_ENTRY, target, runtimePath, options, { ...context, crossRuntimePath }),
    ]);
    if (compiled.some((succeeded) => !succeeded)) {
      return false;
    }

    return true;
  } catch (caughtError) {
    console.error(`❌ Error building ${target.arch}:`, caughtError);
    return false;
  }
}

async function resolveBuildStamp(buildTime: string, buildType: string): Promise<BuildStamp> {
  const gitSha = await captureGitValue(['rev-parse', '--short=12', 'HEAD']);
  const dirtyOutput = await captureGitValue(['status', '--porcelain']);

  return {
    gitSha: gitSha || 'unknown',
    gitDirty: dirtyOutput === null ? 'unknown' : dirtyOutput.length > 0,
    builtAt: buildTime,
    buildType,
  };
}

async function captureGitValue(args: string[]): Promise<string | null> {
  try {
    const { stdout, exitCode } = await captureCommand(['git', ...args], { cwd: ROOT_DIR });
    if (exitCode !== 0) {
      return null;
    }

    return stdout.trim();
  } catch {
    return null;
  }
}

async function writeFrontendBuildInfo(frontendDist: string, buildInfo: BuildStamp): Promise<void> {
  if (!existsSync(frontendDist)) {
    return;
  }

  await Bun.write(join(frontendDist, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
  console.log(`🧾 Frontend build stamp written to ${join(frontendDist, 'build-info.json')}`);
}

async function writeStandaloneArtifacts(
  options: BinaryBuildOptions,
  targets: BinaryTarget[],
  buildTime: string,
  outDir: string
): Promise<void> {
  const readmeContent = `# MangoStudio Executables

## Version ${options.version}
- Build time: ${buildTime}
- Build type: ${options.buildType}

## Available Platforms

${targets.map(({ arch, target }) => `- \`${arch}\` (${target})`).join('\n')}

## Structure

Each platform has its own directory under \`.mango/out/\`:
\`\`\`
.mango/out/
├── linux-x64/
│   ├── mangostudio           # Executable (frontend embedded)
│   └── mangostudio-runtime   # Execution host for stdio environments
├── windows-x64/
│   ├── mangostudio.exe       # Executable (frontend embedded)
│   └── mangostudio-runtime.exe
└── ... (other platforms)
\`\`\`

The runtime binary must stay beside the main executable: MangoStudio resolves it
as a sibling when an environment is configured to run out of process. It is not
meant to be launched by hand.

## Usage

1. **Configuration Files**: Runtime config and secrets are user-owned files.
   MangoStudio reads them from the same place in development and standalone mode:
   - ~/.mango/config.toml
   - ~/.mango/.env (overrides matching config.toml keys)

2. **Database Configuration**: The executable expects a SQLite database file.
   By default, it looks for:
   - Path specified by DATABASE_PATH environment variable
   - ~/.mango/database.sqlite (preferred user data directory)
   - database.sqlite in the runtime base directory if the user data directory is unavailable

   Runtime base directory means:
   - current working directory in development
   - executable directory in standalone mode

3. **Environment Variables**:
   - DATABASE_PATH: Custom path to SQLite database file
   - GEMINI_API_KEY: Google Gemini API key (required)
   - API_PORT: Port to listen on (default: 3001)
   - UPLOADS_DIR: Directory for uploaded files (default: ~/.mango/uploads)

4. **Running** (the binary is a CLI: <binary> <command>):
   Linux/macOS:
   cd .mango/out/linux-x64
   ./mangostudio serve            # foreground on port 3001
   ./mangostudio serve 3000 -d    # background on port 3000
   ./mangostudio status           # show the running instance
   ./mangostudio stop             # graceful shutdown
   ./mangostudio doctor           # environment diagnostics

   Windows:
   cd .mango\\out\\windows-x64
   mangostudio.exe serve

5. **First Run**:
   - The executable will create the database file if it doesn't exist
   - It will run migrations automatically
   - Uploads directory will be created automatically
   - Frontend assets are embedded in the executable
   - API endpoints are available under /api/*
   - Background (-d) runs write logs to ~/.mango/logs/ and track a single
     running instance via ~/.mango/run/server.json

## Notes
- Binaries are standalone and include all dependencies
- No Node.js/Bun runtime required
- Database is stored externally (not embedded in binary)
- Frontend assets are embedded in the executable
`;

  await Bun.write(join(outDir, 'README.md'), readmeContent);
  console.log(`📖 README generated: ${join(outDir, 'README.md')}`);

  const runScript = `#!/bin/bash
# MangoStudio Runner
# Usage: ./run.sh [port] [platform]

PORT=\${1:-3001}
PLATFORM=\${2:-auto}

if [[ "$PLATFORM" == "auto" ]]; then
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)
      if [[ "$ARCH" == "x86_64" ]]; then
        PLATFORM="linux-x64"
      elif [[ "$ARCH" == "aarch64" ]]; then
        PLATFORM="linux-arm64"
      else
        echo "Unsupported architecture: $ARCH"
        exit 1
      fi
      ;;
    Darwin)
      if [[ "$ARCH" == "x86_64" ]]; then
        PLATFORM="darwin-x64"
      elif [[ "$ARCH" == "arm64" ]]; then
        PLATFORM="darwin-arm64"
      else
        echo "Unsupported architecture: $ARCH"
        exit 1
      fi
      ;;
    *)
      echo "Unsupported OS: $OS"
      echo "Please specify platform manually: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64, windows-arm64"
      exit 1
      ;;
  esac
fi

EXECUTABLE_DIR="\${PWD}/.mango/out/\${PLATFORM}"
EXECUTABLE="\${EXECUTABLE_DIR}/mangostudio"

if [[ "$PLATFORM" == windows* ]]; then
  EXECUTABLE="\${EXECUTABLE}.exe"
fi

if [[ ! -d "$EXECUTABLE_DIR" ]]; then
  echo "Platform directory not found: $EXECUTABLE_DIR"
  echo "Available platforms:"
  ls -d .mango/out/*/ 2>/dev/null | sed 's|.mango/out/||' | sed 's|/||' || echo "  (none built yet)"
  exit 1
fi

if [[ ! -f "$EXECUTABLE" ]]; then
  echo "Executable not found: $EXECUTABLE"
  exit 1
fi

echo "Starting MangoStudio on port $PORT"
echo "Platform: $PLATFORM"
echo "Executable: $EXECUTABLE"

cd "$EXECUTABLE_DIR"
chmod +x "$(basename "$EXECUTABLE")" 2>/dev/null || true

# The binary is a CLI; bare invocation prints help, so start the server explicitly.
exec "$(basename "$EXECUTABLE")" serve "$PORT"
`;

  await Bun.write(join(outDir, 'run.sh'), runScript);
  if (process.platform !== 'win32') {
    await Bun.$`chmod +x ${join(outDir, 'run.sh')}`;
  }
  console.log(`🚀 Runner script created: ${join(outDir, 'run.sh')}`);

  const batchScript = `@echo off
REM MangoStudio Runner for Windows
REM Usage: run.bat [port] [platform]

set PORT=%1
if "%PORT%"=="" set PORT=3001

set PLATFORM=%2
if "%PLATFORM%"=="" (
  REM Auto-detect (simplified - assumes x64)
  set PLATFORM=windows-x64
)

set EXECUTABLE_DIR=%~dp0.mango\\out\\%PLATFORM%
set EXECUTABLE=%EXECUTABLE_DIR%\\mangostudio.exe

if not exist "%EXECUTABLE_DIR%" (
  echo Platform directory not found: %EXECUTABLE_DIR%
  echo Available platforms:
  dir /b "%~dp0.mango\\out" 2>nul || echo   (none built yet)
  exit /b 1
)

if not exist "%EXECUTABLE%" (
  echo Executable not found: %EXECUTABLE%
  exit /b 1
)

echo Starting MangoStudio on port %PORT%
echo Platform: %PLATFORM%
echo Executable: %EXECUTABLE%

cd /d "%EXECUTABLE_DIR%"
REM The binary is a CLI; bare invocation prints help, so start the server explicitly.
"%EXECUTABLE%" serve %PORT%
`;

  await Bun.write(join(outDir, 'run.bat'), batchScript);
  console.log(`🚀 Windows runner script created: ${join(outDir, 'run.bat')}`);
}

/**
 * Says so when the channel tag moved while the per-target runtimes were being
 * fetched, which leaves binaries from one build carrying different Bun commits.
 *
 * The signal is the digest, not a revision: a runtime built for another platform
 * cannot be executed here to be asked what it is, so what the build can observe
 * is that the digest published when it read the listing was not the digest that
 * arrived. That covers all eight targets, where executing the host's own asset
 * only ever covered one — and the host no longer fetches an asset at all.
 *
 * Reports and returns — never fails the build. The tag advancing mid-run is a
 * race with an upstream merge, not a defect in the change under test, and there
 * is nothing an author could do about a red build here. A pinned revision would
 * remove the race outright, but Bun publishes no per-commit artifact to pin to.
 */
async function reportCrossRuntimeDrift(channel: string | null): Promise<void> {
  if (!channel) return;

  const runtimes = await bunCompiledRuntimes(channel);
  const advanced = Object.entries(runtimes).filter(([, runtime]) => runtime?.tagAdvanced);
  if (advanced.length === 0) return;

  console.warn(`⚠️  The "${channel}" tag advanced while this build fetched its runtimes:`);
  console.warn(`     host (ran the tests): ${Bun.revision}`);
  for (const [id, runtime] of advanced) {
    console.warn(`     ${id}: compiled against sha256 ${runtime?.sha256}`);
  }
  console.warn('     Not an error; recorded so an artifact that misbehaves can be traced to');
  console.warn('     the Bun actually inside it.');
}

async function buildStandaloneBinary(options: BinaryBuildOptions): Promise<void> {
  header('Build (binary)');

  const targets = filterBinaryTargets(options.onlyPlatform);
  if (targets.length === 0) {
    fatal(
      `No platforms match filter: ${options.onlyPlatform}. Available platforms: ${ALL_BINARY_TARGETS.map((target) => target.arch).join(', ')}`
    );
  }

  const buildTime = new Date().toISOString();
  const buildInfo = await resolveBuildStamp(buildTime, options.buildType);
  const outDir = join(ROOT_DIR, '.mango', 'out');
  let apiSource = join(ROOT_DIR, 'apps/api/src/index.ts');
  const frontendDist = join(ROOT_DIR, 'apps/frontend/dist');

  mkdirSync(outDir, { recursive: true });

  console.log(`📦 Building MangoStudio v${options.version}`);
  console.log(`📅 Build time: ${buildTime}`);
  console.log(`🧾 Build SHA: ${buildInfo.gitSha} (${formatDirtyState(buildInfo.gitDirty)})`);
  console.log(`🎯 Build type: ${options.buildType}`);
  console.log(`📁 Output directory: ${outDir}`);
  console.log('---');

  // Cleared before the sidecar build, not trusted to the build itself: a Turbo
  // cache restore lays its outputs over whatever is already in `dist/` without
  // deleting extras, so repeated local binary builds embedded assets from
  // superseded builds (measured: 58 embedded files where a clean tree gives 57,
  // including a chunk whose source had been reverted). CI and releases build
  // from a clean checkout and never saw it; this makes a local binary equally
  // faithful. Set aside rather than deleted — a failed or interrupted sidecar
  // build must not leave a dev server that was serving this directory with
  // nothing, which is the same transaction `publishDist` in
  // `apps/frontend/build.ts` implements for the same reason.
  const distAside = withFrontendDistAside(frontendDist, options.dryRun);
  try {
    await buildFrontendSidecar(options.dryRun);
  } catch (error) {
    distAside.restore();
    throw error;
  }
  distAside.discard();
  if (options.dryRun) {
    console.log('   (dry run) Would generate embedded frontend modules and compile them in');
  } else {
    await writeFrontendBuildInfo(frontendDist, buildInfo);

    // Compile a generated entry that embeds the frontend dist into the binary,
    // so a stale `public/` sidecar beside the executable can never be served.
    const embed = writeEmbedModules({
      distDir: frontendDist,
      embedDir: join(outDir, 'embed'),
      registryModulePath: join(ROOT_DIR, 'apps/api/src/server/embedded-frontend.ts'),
      apiEntryPath: apiSource,
    });
    apiSource = embed.entryPath;
    console.log(`📦 Embedding frontend into binary (${embed.fileCount} asset file(s))`);
  }

  // Resolved for every target, host included, so the shipped binaries are not a
  // function of which machine ran the build.
  const crossRuntimeChannel = options.dryRun ? null : await bunCrossCompileChannel();
  if (crossRuntimeChannel) {
    console.log(
      `🥟 Bun channel "${crossRuntimeChannel}" has no version-resolvable download; fetching a runtime per target`
    );
    if (options.refreshRuntimes) {
      const cleared = await clearBunCrossRuntimeCache(crossRuntimeChannel);
      console.log(`🧹 Cleared cached ${crossRuntimeChannel} runtimes: ${cleared}`);
    }
  } else if (options.refreshRuntimes) {
    warn(
      options.dryRun
        ? '`--refresh-runtimes` is ignored under `--dry-run`: no runtime is resolved, so there is no cache to clear.'
        : '`--refresh-runtimes` had nothing to clear: `.bun-version` pins a released version, so `--compile` resolves its own downloads.'
    );
  }

  console.log(`🎯 Building executables for ${targets.length} platform(s)`);

  const results = await Promise.all(
    targets.map((target) =>
      buildStandaloneTarget(target, options, {
        apiSource,
        buildTime,
        buildInfo,
        outDir,
        crossRuntimeChannel,
      })
    )
  );

  const successCount = results.filter(Boolean).length;
  const failedCount = results.length - successCount;

  console.log('---');
  await reportCrossRuntimeDrift(crossRuntimeChannel);
  console.log('📊 Build summary:');
  console.log(`✅ ${successCount} platform(s) built successfully`);

  if (failedCount > 0) {
    console.log(`❌ ${failedCount} platform(s) failed`);
    process.exit(1);
  }

  await writeStandaloneArtifacts(options, targets, buildTime, outDir);

  console.log('🎉 Build completed successfully!');
  console.log(`📁 Output structure: ${outDir}/`);
  console.log('📋 To run:');
  console.log('  Linux/macOS: ./.mango/out/run.sh');
  console.log('  Windows:     .mango\\out\\run.bat');
}

const { workspaces, flags, values, positional, usedDefaultSelection } = parseArgs({
  booleanFlags: ['--binary', '--production', '--development', '--dry-run', '--refresh-runtimes'],
  valueFlags: ['--platform'],
});

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

const isBinaryBuild = flags['--binary'] ?? false;
const isProductionBuild = flags['--production'] ?? false;
const isDevelopmentBuild = flags['--development'] ?? false;
const refreshRuntimes = flags['--refresh-runtimes'] ?? false;
const defaultBuildWorkspaces: WorkspaceName[] = ['frontend'];

if (isProductionBuild && isDevelopmentBuild) {
  fatal('Choose either `--production` or `--development`, not both.');
}

if (
  !isBinaryBuild &&
  (isProductionBuild || isDevelopmentBuild || refreshRuntimes || values['--platform'])
) {
  fatal(
    '`--platform`, `--production`, `--development`, and `--refresh-runtimes` require `--binary`.'
  );
}

if (isBinaryBuild) {
  let version: string;
  try {
    version = resolveReleaseVersion();
  } catch (caught) {
    fatal(caught instanceof Error ? caught.message : String(caught));
  }

  await buildStandaloneBinary({
    buildType: isDevelopmentBuild ? 'development' : 'production',
    dryRun: flags['--dry-run'] ?? process.env.DRY_RUN === '1',
    onlyPlatform: values['--platform'] ?? process.env.ONLY_PLATFORM,
    refreshRuntimes,
    version,
  });
  process.exit(0);
}

if (process.argv.includes('--root')) {
  warn('Ignoring `--root` for workspace builds.');
}

const requestedWorkspaces = usedDefaultSelection ? defaultBuildWorkspaces : workspaces;
const { runnableWorkspaces: buildTargets, skippedWorkspaces } =
  selectBuildWorkspaces(requestedWorkspaces);

if (skippedWorkspaces.length > 0) {
  warn(`Skipping workspaces without a build entrypoint: ${skippedWorkspaces.join(', ')}`);
}

if (buildTargets.length === 0) {
  fatal(
    'No build-capable workspace selected. Use `--frontend`, `--api`, `--runtime`, or `--binary`.'
  );
}

header('Build');

const result = await runCommand('build', createTurboBuildCommand(buildTargets), {
  cwd: ROOT_DIR,
});

if (result.exitCode === 0 && buildTargets.includes('frontend')) {
  const buildTime = new Date().toISOString();
  await writeFrontendBuildInfo(
    join(ROOT_DIR, 'apps/frontend/dist'),
    await resolveBuildStamp(buildTime, 'production')
  );
}

process.exit(result.exitCode);

function formatDirtyState(state: BuildStamp['gitDirty']): string {
  if (state === true) {
    return 'dirty';
  }
  if (state === false) {
    return 'clean';
  }
  return 'dirty unknown';
}
