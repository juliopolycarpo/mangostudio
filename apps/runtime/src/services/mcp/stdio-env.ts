/**
 * Environment allowlist for spawned stdio MCP servers.
 *
 * The API process holds connector API keys and its own auth secret in
 * process.env, so child servers must not inherit the environment wholesale —
 * only a small allowlist plus the row's explicit (non-secret) env is
 * forwarded. Same rationale as the shell tools' `_shell-env.ts`, but inverted:
 * shell commands get everything minus secrets, MCP servers get nothing plus
 * the basics, because unlike a shell they rarely need arbitrary variables.
 */

const INHERITED_ENV_KEYS: readonly string[] =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
        'PROGRAMFILES',
      ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'TMPDIR', 'LANG', 'LC_ALL'];

/**
 * Builds the child env for a stdio MCP server: allowlisted inherited
 * variables merged with the server row's env (row wins on conflict).
 * // Usage: new StdioClientTransport({ env: buildStdioEnv(row.env) })
 */
export function buildStdioEnv(
  serverEnv: Record<string, string>,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    // Skip exported shell functions ("() { ... }") — never a usable value and
    // a Shellshock-style injection vector for children that re-export them.
    if (value.startsWith('()')) continue;
    env[key] = value;
  }
  return { ...env, ...serverEnv };
}
