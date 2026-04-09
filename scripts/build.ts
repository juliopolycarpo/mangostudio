#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

import { ROOT_DIR, type WorkspaceName } from './lib/config';
import {
  assertNoUnexpectedArguments,
  exitWithResults,
  fatal,
  header,
  parseArgs,
  runParallel,
  runWorkspaceScript,
  warn,
  type RunResult,
} from './lib/runner';

interface BinaryTarget {
  target: string;
  arch: string;
  name: string;
}

interface BinaryBuildOptions {
  buildType: 'production' | 'development';
  dryRun: boolean;
  onlyPlatform?: string;
  version: string;
}

const BUILDABLE_WORKSPACES: WorkspaceName[] = ['frontend', 'api'];
const ALL_BINARY_TARGETS: BinaryTarget[] = [
  { target: 'bun-linux-x64', arch: 'linux-x64', name: 'mangostudio' },
  { target: 'bun-linux-arm64', arch: 'linux-arm64', name: 'mangostudio' },
  { target: 'bun-windows-x64', arch: 'windows-x64', name: 'mangostudio.exe' },
  { target: 'bun-windows-arm64', arch: 'windows-arm64', name: 'mangostudio.exe' },
  { target: 'bun-darwin-x64', arch: 'darwin-x64', name: 'mangostudio' },
  { target: 'bun-darwin-arm64', arch: 'darwin-arm64', name: 'mangostudio' },
  { target: 'bun-linux-x64-musl', arch: 'linux-x64-musl', name: 'mangostudio' },
  { target: 'bun-linux-arm64-musl', arch: 'linux-arm64-musl', name: 'mangostudio' },
];

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
  --help           Show this help message`);
  process.exit(0);
}

function resolveBinaryTargets(onlyPlatform?: string): BinaryTarget[] {
  if (!onlyPlatform) {
    return ALL_BINARY_TARGETS;
  }

  return ALL_BINARY_TARGETS.filter(
    (target) => target.arch === onlyPlatform || target.target === onlyPlatform
  );
}

async function buildFrontendSidecar(dryRun: boolean): Promise<void> {
  console.log('🏗️  Building frontend sidecar...');

  if (dryRun) {
    console.log('   (dry run) Would build @mangostudio/frontend');
    console.log('✅ Frontend built successfully (dry run)');
    return;
  }

  const result = await runWorkspaceScript('frontend', 'build');
  if (result.exitCode !== 0) {
    fatal('Frontend build failed during standalone binary packaging.');
  }
}

async function buildStandaloneTarget(
  target: BinaryTarget,
  options: BinaryBuildOptions,
  context: { apiSource: string; buildTime: string; frontendDist: string; outDir: string }
): Promise<boolean> {
  const platformOutDir = join(context.outDir, target.arch);
  mkdirSync(platformOutDir, { recursive: true });

  const binaryPath = join(platformOutDir, target.name);

  console.log(`🔨 Building for ${target.arch} (${target.target}) → ${binaryPath}`);

  if (options.dryRun) {
    console.log(`   (dry run) Would compile for ${target.target}`);
    console.log(`✅ Successfully built ${target.name} for ${target.arch} (dry run)`);
    console.log(`📁 Would copy frontend dist to ${join(platformOutDir, 'public')}`);
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

    const proc = Bun.spawn({
      cmd: ['bun', ...args],
      cwd: ROOT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

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

    return true;
  } catch (caughtError) {
    console.error(`❌ Error building ${target.arch}:`, caughtError);
    return false;
  }
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

1. **Database Configuration**: The executable expects a SQLite database file.
   By default, it looks for:
   - Path specified by \`DATABASE_PATH\` environment variable
   - \`~/.mangostudio/database.sqlite\` (preferred user data directory)
   - \`database.sqlite\` in the runtime base directory if the user data directory is unavailable

   Runtime base directory means:
   - current working directory in development
   - executable directory in standalone mode

2. **Environment Variables**:
   - \`DATABASE_PATH\`: Custom path to SQLite database file
   - \`GEMINI_API_KEY\`: Google Gemini API key (required)
   - \`API_PORT\`: Port to listen on (default: 3001)
   - \`UPLOADS_DIR\`: Directory for uploaded files (default: runtime-base-dir/uploads)

3. **Running**:
   \`\`\`bash
   # Linux/macOS
   cd .mango/out/linux-x64
   ./mangostudio

   # Windows
   cd .mango\\out\\windows-x64
   mangostudio.exe
   \`\`\`

4. **First Run**:
   - The executable will create the database file if it doesn't exist
   - It will run migrations automatically
   - Uploads directory will be created automatically
   - Frontend assets are served from the sidecar \`public/\` directory
   - API endpoints are available under \`/api/*\`

## Notes
- Binaries are standalone and include all dependencies
- No Node.js/Bun runtime required
- Database is stored externally (not embedded in binary)
- Frontend assets are copied beside the executable in \`public/\`
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

export API_PORT=$PORT
exec "$(basename "$EXECUTABLE")"
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

set API_PORT=%PORT%
cd /d "%EXECUTABLE_DIR%"
"%EXECUTABLE%"
`;

  await Bun.write(join(outDir, 'run.bat'), batchScript);
  console.log(`🚀 Windows runner script created: ${join(outDir, 'run.bat')}`);
}

async function buildStandaloneBinary(options: BinaryBuildOptions): Promise<void> {
  header('Build (binary)');

  const targets = resolveBinaryTargets(options.onlyPlatform);
  if (targets.length === 0) {
    fatal(
      `No platforms match filter: ${options.onlyPlatform}. Available platforms: ${ALL_BINARY_TARGETS.map((target) => target.arch).join(', ')}`
    );
  }

  const buildTime = new Date().toISOString();
  const outDir = join(ROOT_DIR, '.mango', 'out');
  const apiSource = join(ROOT_DIR, 'apps/api/src/index.ts');
  const frontendDist = join(ROOT_DIR, 'apps/frontend/dist');

  mkdirSync(outDir, { recursive: true });

  console.log(`📦 Building MangoStudio v${options.version}`);
  console.log(`📅 Build time: ${buildTime}`);
  console.log(`🎯 Build type: ${options.buildType}`);
  console.log(`📁 Output directory: ${outDir}`);
  console.log('---');

  await buildFrontendSidecar(options.dryRun);

  console.log(`🎯 Building executables for ${targets.length} platform(s)`);

  const results = await Promise.all(
    targets.map((target) =>
      buildStandaloneTarget(target, options, { apiSource, buildTime, frontendDist, outDir })
    )
  );

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

const { workspaces, includeRoot, flags, values, positional, usedDefaultSelection } = parseArgs({
  booleanFlags: ['--binary', '--production', '--development'],
  valueFlags: ['--platform'],
});

assertNoUnexpectedArguments(positional);

if (flags['--help']) {
  printHelp();
}

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
  await buildStandaloneBinary({
    buildType: isDevelopmentBuild ? 'development' : 'production',
    dryRun: process.env.DRY_RUN === '1',
    onlyPlatform: values['--platform'] ?? process.env.ONLY_PLATFORM,
    version: process.env.VERSION || '0.0.1',
  });
  process.exit(0);
}

if (includeRoot) {
  warn('Ignoring `--root` for workspace builds.');
}

const requestedWorkspaces = usedDefaultSelection ? defaultBuildWorkspaces : workspaces;
const buildTargets = requestedWorkspaces.filter((workspace) =>
  BUILDABLE_WORKSPACES.includes(workspace)
);
const skippedWorkspaces = requestedWorkspaces.filter(
  (workspace) => !BUILDABLE_WORKSPACES.includes(workspace)
);

if (skippedWorkspaces.length > 0) {
  warn(`Skipping workspaces without a build entrypoint: ${skippedWorkspaces.join(', ')}`);
}

if (buildTargets.length === 0) {
  fatal('No build-capable workspace selected. Use `--frontend`, `--api`, or `--binary`.');
}

header('Build');

const results: RunResult[] = await runParallel(
  buildTargets.map((workspace) => () => runWorkspaceScript(workspace, 'build', { ifPresent: true }))
);

exitWithResults(results);
