import type { BinaryTarget } from './release-targets';

/**
 * Render the common README after every requested binary has been verified.
 * @example renderStandaloneReadme({version: '1.0.0', buildType: 'production'}, targets, builtAt)
 */
export function renderStandaloneReadme(
  options: { readonly version: string; readonly buildType: string },
  targets: readonly BinaryTarget[],
  buildTime: string
): string {
  return `# MangoStudio Executables

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
}
