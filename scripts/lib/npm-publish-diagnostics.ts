import type { NpmCommandResult } from './npm-publish';

const OIDC_MESSAGES = [
  [
    'Skipped because incorrect permissions for id-token',
    'GitHub token request prerequisites missing',
  ],
  [
    'Failed to fetch id_token from GitHub: received an invalid response',
    'GitHub token request failed',
  ],
  [
    'Failed to fetch id_token from GitHub: missing value',
    'GitHub token response missing identity token',
  ],
  ['Skipped because no id_token available', 'identity token unavailable'],
  ['Failed token exchange request with body message:', 'npm token exchange failed'],
  [
    'Failed because token exchange was missing the token in the response body',
    'npm token exchange response missing credential',
  ],
  ['Successfully retrieved and set token', 'npm token exchange credential received'],
  ['Failure with message:', 'OIDC client operation failed'],
] as const;

/**
 * Retain npm's authentication stages without copying verbose payloads or URLs.
 * Usage: sanitizeNpmPublishResult(result, process.env).
 */
export function sanitizeNpmPublishResult(
  result: NpmCommandResult,
  env: NodeJS.ProcessEnv
): NpmCommandResult {
  const diagnostics = new Set<string>();
  const stderr = ordinaryOutput(result.stderr, diagnostics, env);
  const stdout = ordinaryOutput(result.stdout, diagnostics, env);
  if (result.exitCode !== 0) diagnostics.add(prerequisiteSummary(env));
  return { ...result, stdout, stderr, diagnostics: [...diagnostics] };
}

function ordinaryOutput(output: string, diagnostics: Set<string>, env: NodeJS.ProcessEnv): string {
  const ordinary: string[] = [];
  let debugContinuation = false;
  for (const rawLine of output.split('\n')) {
    const line = Bun.stripANSI(rawLine);
    if (/^npm (?:verbose|http|silly|info|timing)\b/.test(line)) {
      collectDiagnostic(line, diagnostics, env);
      debugContinuation = true;
      continue;
    }
    if (/^npm (?:notice|error|ERR!|warn)(?:\s|$)/.test(line)) debugContinuation = false;
    if (!debugContinuation) ordinary.push(line);
  }
  return ordinary.join('\n');
}

function collectDiagnostic(line: string, diagnostics: Set<string>, env: NodeJS.ProcessEnv): void {
  if (line.startsWith('npm verbose oidc ')) {
    const message = line.slice('npm verbose oidc '.length);
    const category = OIDC_MESSAGES.find(([prefix]) => message.startsWith(prefix))?.[1];
    diagnostics.add(`npm authentication: ${category ?? 'unrecognized OIDC diagnostic'}.`);
    return;
  }
  const request = /^npm http fetch (GET|POST) (\S+) (\S+)/.exec(line);
  if (!request) return;
  const statusFirst = /^[1-5]\d{2}$/.test(request[2]);
  const status = statusFirst ? request[2] : request[3];
  if (!/^[1-5]\d{2}$/.test(status)) return;
  const url = parseUrl(statusFirst ? request[3] : request[2]);
  if (!url) return;
  const github = parseUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (request[1] === 'GET' && url.origin === github?.origin && url.pathname === github.pathname) {
    diagnostics.add(`npm authentication: GitHub token request HTTP ${status}.`);
  }
  if (
    request[1] === 'POST' &&
    url.origin === 'https://registry.npmjs.org' &&
    url.pathname.startsWith('/-/npm/v1/oidc/token/exchange/package/')
  ) {
    diagnostics.add(`npm authentication: npm token exchange HTTP ${status}.`);
  }
}

function parseUrl(value: string | undefined): URL | undefined {
  if (!value) return;
  try {
    return new URL(value);
  } catch {
    return;
  }
}

function prerequisiteSummary(env: NodeJS.ProcessEnv): string {
  return `npm authentication prerequisites present: GITHUB_ACTIONS=${Boolean(env.GITHUB_ACTIONS)}, ACTIONS_ID_TOKEN_REQUEST_URL=${Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL)}, ACTIONS_ID_TOKEN_REQUEST_TOKEN=${Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)}.`;
}
