/**
 * Builds the sanitized environment handed to AI-invoked shell subprocesses.
 *
 * The server keeps connector API keys (and its own auth secret) in process.env
 * so environment-source connectors resolve at runtime. The shell tools let the
 * AI run arbitrary commands, so the child must NOT inherit those secrets — a
 * single `env`/`printenv` would otherwise exfiltrate every provider key. Secret-
 * shaped variables are stripped; everything else (PATH, HOME, proxy, locale…)
 * is forwarded so ordinary commands still work.
 */

/**
 * Matches environment variable names that carry credentials. Covers connector
 * secrets (`<PROVIDER>_API_KEY[_<NAME>]`), the app's `BETTER_AUTH_SECRET`, and
 * the common token / password / credential / access-key shapes.
 */
const SECRET_ENV_KEY =
  /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)/i;

/**
 * Reports whether an env var name looks like a credential and must be withheld
 * from untrusted child processes.
 * // Usage: isSecretEnvKey('GEMINI_API_KEY_DEFAULT') // → true
 */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key);
}

/**
 * Returns a copy of `source` with secret-shaped variables removed, for use as
 * the explicit env of an AI-spawned shell. Bun.spawn replaces (not merges) the
 * child env when `env` is passed, so starting from the full environment keeps
 * the operator's PATH/HOME/etc. while dropping only the secrets.
 * // Usage: Bun.spawn(cmd, { env: sanitizeShellEnv() })
 */
export function sanitizeShellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isSecretEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}
