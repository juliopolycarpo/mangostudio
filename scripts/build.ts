#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTurboBuildCommand, selectBuildWorkspaces } from './lib/build';
import { ROOT_DIR, type WorkspaceName } from './lib/config';
import {
  assembleCursorSidecar,
  type CursorSidecarStaging,
  cursorNativePackageFor,
  prepareCursorSidecarStaging,
} from './lib/cursor-sidecar';
import { writeEmbedModules } from './lib/embed-frontend';
import { ALL_BINARY_TARGETS, type BinaryTarget, filterBinaryTargets } from './lib/release-targets';
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

interface BinaryBuildOptions {
  buildType: 'production' | 'development';
  dryRun: boolean;
  onlyPlatform?: string;
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
  --all        Build every build-capable workspace

Binary flags:
  --binary         Build standalone binaries into .mango/out
  --platform <id>  Limit binary output to one target (example: linux-x64)
  --production     Use production binary settings (default)
  --development    Use development binary settings
  --dry-run        Preview the build without writing artifacts
  --help           Show this help message`);
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

async function buildStandaloneTarget(
  target: BinaryTarget,
  options: BinaryBuildOptions,
  context: {
    apiSource: string;
    buildTime: string;
    buildInfo: BuildStamp;
    frontendDist: string;
    outDir: string;
    cursorSidecar: CursorSidecarStaging | null;
  }
): Promise<boolean> {
  const platformOutDir = join(context.outDir, target.arch);
  mkdirSync(platformOutDir, { recursive: true });

  const binaryPath = join(platformOutDir, target.name);

  console.log(`🔨 Building for ${target.arch} (${target.target}) → ${binaryPath}`);

  if (options.dryRun) {
    console.log(`   (dry run) Would compile for ${target.target}`);
    console.log(`✅ Successfully built ${target.name} for ${target.arch} (dry run)`);
    console.log(`📁 Would copy frontend dist to ${join(platformOutDir, 'public')}`);
    if (cursorNativePackageFor(target)) {
      console.log(`📁 Would vendor Cursor sidecar to ${join(platformOutDir, 'cursor-sidecar')}`);
    } else {
      console.log(`⏭️  Cursor sidecar unsupported for ${target.arch}; would skip`);
    }
    return true;
  }

  try {
    const args = [
      'build',
      context.apiSource,
      '--compile',
      '--target',
      target.target,
      '--outfile',
      binaryPath,
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

    const { stdout, stderr, exitCode } = await captureCommand(['bun', ...args], { cwd: ROOT_DIR });

    if (exitCode !== 0) {
      console.error(`❌ Failed to build ${target.arch}:`);
      if (stderr.trim()) console.error(stderr.trim());
      return false;
    }

    console.log(`✅ Successfully built ${target.name} for ${target.arch}`);
    if (stdout.trim()) console.log(stdout.trim());

    const frontendDestination = join(platformOutDir, 'public');
    if (existsSync(context.frontendDist)) {
      cpSync(context.frontendDist, frontendDestination, { recursive: true });
      console.log(`📁 Copied frontend dist to ${frontendDestination}`);
    }

    if (context.cursorSidecar) {
      const cursorSidecarDestination = join(platformOutDir, 'cursor-sidecar');
      const staged = assembleCursorSidecar(cursorSidecarDestination, target, context.cursorSidecar);
      if (staged) {
        console.log(`📁 Vendored Cursor sidecar to ${cursorSidecarDestination}`);
      } else {
        console.log(`⏭️  Cursor sidecar unsupported for ${target.arch}; skipped`);
      }
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
│   ├── mangostudio           # Executable
│   └── public/               # Frontend static files
├── windows-x64/
│   ├── mangostudio.exe       # Executable
│   └── public/               # Frontend static files
└── ... (other platforms)
\`\`\`

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
- Frontend assets are embedded in the executable; the \`public/\` copy beside it
  is staged for compatibility only and is never served
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

  await buildFrontendSidecar(options.dryRun);
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

  const cursorSidecar = options.dryRun ? null : await prepareCursorSidecarStaging(targets);

  console.log(`🎯 Building executables for ${targets.length} platform(s)`);

  let results: boolean[];
  try {
    results = await Promise.all(
      targets.map((target) =>
        buildStandaloneTarget(target, options, {
          apiSource,
          buildTime,
          buildInfo,
          frontendDist,
          outDir,
          cursorSidecar,
        })
      )
    );
  } finally {
    cursorSidecar?.cleanup();
  }

  const successCount = results.filter(Boolean).length;
  const failedCount = results.length - successCount;

  console.log('---');
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
  booleanFlags: ['--binary', '--production', '--development', '--dry-run'],
  valueFlags: ['--platform'],
});

if (flags['--help']) {
  printHelp();
}

assertNoUnexpectedArguments(positional);

const isBinaryBuild = flags['--binary'] ?? false;
const isProductionBuild = flags['--production'] ?? false;
const isDevelopmentBuild = flags['--development'] ?? false;
const defaultBuildWorkspaces: WorkspaceName[] = ['frontend'];

if (isProductionBuild && isDevelopmentBuild) {
  fatal('Choose either `--production` or `--development`, not both.');
}

if (!isBinaryBuild && (isProductionBuild || isDevelopmentBuild || values['--platform'])) {
  fatal('`--platform`, `--production`, and `--development` require `--binary`.');
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
  fatal('No build-capable workspace selected. Use `--frontend`, `--api`, or `--binary`.');
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
