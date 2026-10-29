/**
 * Generate runners that ship beside the standalone platform directories.
 *
 * @example const { shell, batch } = standaloneRunnerScripts();
 */
export function standaloneRunnerScripts(): { shell: string; batch: string } {
  return {
    shell: `#!/bin/bash
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

BUNDLE_DIR="$(CDPATH= cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)" || exit 1
EXECUTABLE_DIR="\${BUNDLE_DIR}/\${PLATFORM}"
EXECUTABLE="\${EXECUTABLE_DIR}/mangostudio"

if [[ "$PLATFORM" == windows* ]]; then
  EXECUTABLE="\${EXECUTABLE}.exe"
fi

if [[ ! -d "$EXECUTABLE_DIR" ]]; then
  echo "Platform directory not found: $EXECUTABLE_DIR"
  echo "Available platforms:"
  for directory in "$BUNDLE_DIR"/*/; do
    [[ -d "$directory" ]] && basename "$directory"
  done
  exit 1
fi

if [[ ! -f "$EXECUTABLE" ]]; then
  echo "Executable not found: $EXECUTABLE"
  exit 1
fi

echo "Starting MangoStudio on port $PORT"
echo "Platform: $PLATFORM"
echo "Executable: $EXECUTABLE"

cd "$EXECUTABLE_DIR" || exit 1
chmod +x "$EXECUTABLE" 2>/dev/null || true

# The binary is a CLI; bare invocation prints help, so start the server explicitly.
exec "$EXECUTABLE" serve "$PORT"
`,
    batch: `@echo off
REM MangoStudio Runner for Windows
REM Usage: run.bat [port] [platform]

setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=3001"

set "PLATFORM=%~2"
if "%PLATFORM%"=="" (
  REM Auto-detect (simplified - assumes x64)
  set "PLATFORM=windows-x64"
)

set "EXECUTABLE_DIR=%~dp0%PLATFORM%"
set "EXECUTABLE=%EXECUTABLE_DIR%\\mangostudio.exe"

if not exist "%EXECUTABLE_DIR%" (
  echo Platform directory not found: "%EXECUTABLE_DIR%"
  echo Available platforms:
  dir /b /ad "%~dp0" 2>nul || echo   none built yet
  exit /b 1
)

if not exist "%EXECUTABLE%" (
  echo Executable not found: "%EXECUTABLE%"
  exit /b 1
)

echo Starting MangoStudio on port %PORT%
echo Platform: %PLATFORM%
echo Executable: "%EXECUTABLE%"

cd /d "%EXECUTABLE_DIR%" || exit /b 1
REM The binary is a CLI; bare invocation prints help, so start the server explicitly.
"%EXECUTABLE%" serve "%PORT%"
exit /b %errorlevel%
`,
  };
}
