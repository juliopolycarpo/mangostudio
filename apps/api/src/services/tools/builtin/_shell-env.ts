/**
 * Builds the sanitized environment handed to AI-invoked shell subprocesses.
 *
 * The server keeps connector API keys (and its own auth secret) in process.env
 * so environment-source connectors resolve at runtime. The shell tools run
 * arbitrary AI-issued commands, so the child must NOT inherit those secrets — a
 * single `env`/`printenv` would otherwise exfiltrate every provider key. Secret-
 * shaped variables are stripped by default; everything else (PATH, HOME, proxy,
 * locale…) is forwarded so ordinary commands still work. Operators tune the
 * built-in denylist per shell tool via an allow/deny policy.
 */

/**
 * Matches environment variable names that carry credentials. Covers connector
 * secrets (`<PROVIDER>_API_KEY[_<NAME>]`), the app's `BETTER_AUTH_SECRET`, and
 * the common token / password / credential / access-key shapes.
 */
const SECRET_ENV_KEY =
  /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/i;

/** Operator overrides for the built-in secret denylist, configured per shell tool. */
export interface ShellEnvPolicy {
  /** Exact env var names forwarded to commands even when they look like secrets. */
  allow?: readonly string[];
  /** Exact env var names always withheld, on top of the auto-detected secrets. */
  deny?: readonly string[];
}

/**
 * Reports whether an env var name looks like a credential and must be withheld
 * from untrusted child processes.
 * // Usage: isSecretEnvKey('GEMINI_API_KEY_DEFAULT') // → true
 */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key);
}

/**
 * Decides if a variable is kept from a child process. Explicit deny wins over an
 * explicit allow, which in turn overrides the built-in secret detection.
 */
function isWithheld(key: string, policy: ShellEnvPolicy): boolean {
  if (policy.deny?.includes(key)) return true;
  if (policy.allow?.includes(key)) return false;
  return isSecretEnvKey(key);
}

/**
 * Returns a copy of `source` with withheld variables removed, for use as the
 * explicit env of an AI-spawned shell. Bun.spawn replaces (not merges) the child
 * env when `env` is passed, so starting from the full environment keeps the
 * operator's PATH/HOME/etc. while dropping the secrets.
 * // Usage: Bun.spawn(cmd, { env: sanitizeShellEnv({ allow: ['GITHUB_TOKEN'] }) })
 */
export function sanitizeShellEnv(
  policy: ShellEnvPolicy = {},
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isWithheld(key, policy)) continue;
    env[key] = value;
  }
  return env;
}
