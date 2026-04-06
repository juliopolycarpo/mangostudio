#!/usr/bin/env bun
/**
 * Build script for MangoStudio executable.
 * Compiles the API server into standalone binaries for multiple platforms.
 * Copies the frontend dist beside each executable as a public sidecar directory.
 * Defines build-time constants and optimizes for production.
 */

import { join } from 'path';
import { mkdirSync, cpSync } from 'fs';

// Build configuration
const BUILD_TIME = new Date().toISOString();
const BUILD_TYPE = process.env.BUILD_TYPE || 'production';
const VERSION = process.env.VERSION || '0.0.1';
const DRY_RUN = process.env.DRY_RUN === '1';

// Directory paths
const ROOT_DIR = join(import.meta.dir, '..');
const OUT_DIR = join(ROOT_DIR, '.mango', 'out');
const API_SRC = join(ROOT_DIR, 'apps/api/src/index.ts');
const FRONTEND_DIR = join(ROOT_DIR, 'apps/frontend');
const FRONTEND_DIST = join(FRONTEND_DIR, 'dist');

// Target platforms for compilation
const ALL_TARGETS = [
  { target: 'bun-linux-x64', arch: 'linux-x64', name: 'mangostudio' },
  { target: 'bun-linux-arm64', arch: 'linux-arm64', name: 'mangostudio' },
  { target: 'bun-windows-x64', arch: 'windows-x64', name: 'mangostudio.exe' },
  { target: 'bun-windows-arm64', arch: 'windows-arm64', name: 'mangostudio.exe' },
  { target: 'bun-darwin-x64', arch: 'darwin-x64', name: 'mangostudio' },
  { target: 'bun-darwin-arm64', arch: 'darwin-arm64', name: 'mangostudio' },
  { target: 'bun-linux-x64-musl', arch: 'linux-x64-musl', name: 'mangostudio' },
  { target: 'bun-linux-arm64-musl', arch: 'linux-arm64-musl', name: 'mangostudio' },
];

// Filter targets if ONLY_PLATFORM is set
const ONLY_PLATFORM = process.env.ONLY_PLATFORM;
const TARGETS = ONLY_PLATFORM
  ? ALL_TARGETS.filter((t) => t.arch === ONLY_PLATFORM || t.target === ONLY_PLATFORM)
  : ALL_TARGETS;

if (TARGETS.length === 0) {
  console.error(`❌ No platforms match filter: ${ONLY_PLATFORM}`);
  console.error(`   Available platforms: ${ALL_TARGETS.map((t) => t.arch).join(', ')}`);
  process.exit(1);
}

// Ensure output directory exists
mkdirSync(OUT_DIR, { recursive: true });

console.log(`📦 Building MangoStudio v${VERSION}`);
console.log(`📅 Build time: ${BUILD_TIME}`);
console.log(`🎯 Build type: ${BUILD_TYPE}`);
console.log(`📁 Output directory: ${OUT_DIR}`);
console.log('---');

async function buildFrontend(): Promise<void> {
  console.log('🏗️  Building frontend...');

  if (DRY_RUN) {
    console.log('   (dry run) Would run: bun run build in', FRONTEND_DIR);
    console.log('✅ Frontend built successfully (dry run)');
    return;
  }

  try {
    // Run vite build
    const proc = Bun.spawn({
      cmd: ['bun', 'run', 'build'],
      cwd: FRONTEND_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log('✅ Frontend built successfully');
      if (output.trim()) console.log(output.trim());
    } else {
      console.error('❌ Frontend build failed:');
      if (error.trim()) console.error(error.trim());
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error building frontend:', error);
    process.exit(1);
  }
}

async function buildForPlatform(
  platform: string,
  arch: string,
  outputName: string
): Promise<boolean> {
  const platformOutDir = join(OUT_DIR, arch);
  mkdirSync(platformOutDir, { recursive: true });

  const binaryPath = join(platformOutDir, outputName);

  console.log(`🔨 Building for ${arch} (${platform}) → ${binaryPath}`);

  try {
    // Dry run mode - skip actual compilation
    if (DRY_RUN) {
      console.log(`   (dry run) Would compile for ${platform}`);
      // Simulate success
      console.log(`✅ Successfully built ${outputName} for ${arch} (dry run)`);

      // Simulate copying frontend
      const frontendDest = join(platformOutDir, 'public');
      console.log(`📁 Would copy frontend dist to ${frontendDest}`);
      return true;
    }

    // Use bun build --compile to create standalone executable
    const args = [
      'build',
      API_SRC,
      '--compile',
      '--target',
      platform,
      '--outfile',
      binaryPath,
      '--define',
      `process.env.BUILD_TIME=${JSON.stringify(BUILD_TIME)}`,
      '--define',
      `process.env.BUILD_TYPE=${JSON.stringify(BUILD_TYPE)}`,
      '--define',
      `process.env.VERSION=${JSON.stringify(VERSION)}`,
      '--define',
      'process.env.NODE_ENV="production"',
    ];

    if (BUILD_TYPE === 'production') {
      args.push('--minify');
    }

    args.push('--sourcemap=external');

    const proc = Bun.spawn({
      cmd: ['bun', ...args],
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: ROOT_DIR,
    });

    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log(`✅ Successfully built ${outputName} for ${arch}`);
      if (output.trim()) console.log(output.trim());

      // Copy frontend dist to platform output directory
      const frontendDest = join(platformOutDir, 'public');
      if (await Bun.file(FRONTEND_DIST).exists()) {
        cpSync(FRONTEND_DIST, frontendDest, { recursive: true });
        console.log(`📁 Copied frontend dist to ${frontendDest}`);
      }

      return true;
    } else {
      console.error(`❌ Failed to build ${arch}:`);
      if (error.trim()) console.error(error.trim());
      return false;
    }
  } catch (error) {
    console.error(`❌ Error building ${arch}:`, error);
    return false;
  }
}

async function buildAll(): Promise<void> {
  // First build the frontend
  await buildFrontend();

  console.log(`🎯 Building executables for ${TARGETS.length} platforms`);

  const results = await Promise.all(
    TARGETS.map(({ target, arch, name }) => buildForPlatform(target, arch, name))
  );

  const successCount = results.filter(Boolean).length;
  const failedCount = results.length - successCount;

  console.log('---');
  console.log(`📊 Build summary:`);
  console.log(`✅ ${successCount} platforms built successfully`);
  if (failedCount > 0) {
    console.log(`❌ ${failedCount} platforms failed`);
    process.exit(1);
  }

  // Create a global README with usage instructions
  const readmeContent = `# MangoStudio Executables

## Version ${VERSION}
- Build time: ${BUILD_TIME}
- Build type: ${BUILD_TYPE}

## Available Platforms

${TARGETS.map(({ arch, target }) => `- \`${arch}\` (${target})`).join('\n')}

## Structure

Each platform has its own directory under \`.mango/out/\`:
\`\`\`
.mango/out/
├── linux-x64/
│   ├── mangostudio           # Executable
│   └── public/              # Frontend static files
├── windows-x64/
│   ├── mangostudio.exe      # Executable
│   └── public/              # Frontend static files
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

  await Bun.write(join(OUT_DIR, 'README.md'), readmeContent);
  console.log(`📖 README generated: ${join(OUT_DIR, 'README.md')}`);

  // Create a simple cross-platform runner script
  const runScript = `#!/bin/bash
# MangoStudio Runner
# Usage: ./run.sh [port] [platform]

PORT=\${1:-3001}
PLATFORM=\${2:-auto}

# Auto-detect platform if not specified
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

# Windows adjustment
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

  await Bun.write(join(OUT_DIR, 'run.sh'), runScript);
  if (process.platform !== 'win32') {
    await Bun.$`chmod +x ${join(OUT_DIR, 'run.sh')}`;
  }
  console.log(`🚀 Runner script created: ${join(OUT_DIR, 'run.sh')}`);

  // Create a Windows batch file
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

  await Bun.write(join(OUT_DIR, 'run.bat'), batchScript);
  console.log(`🚀 Windows runner script created: ${join(OUT_DIR, 'run.bat')}`);

  console.log('🎉 Build completed successfully!');
  console.log(`📁 Output structure: ${OUT_DIR}/`);
  console.log('📋 To run:');
  console.log('  Linux/macOS: ./.mango/out/run.sh');
  console.log('  Windows:     .mango\\out\\run.bat');
}

// Run the build
await buildAll();
