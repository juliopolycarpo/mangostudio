/**
 * Smoke test for external API key authentication against a running server.
 *
 * Usage:
 *   MANGO_API_KEY='mango_…' bun run scripts/examples/external-api-smoke.ts [baseUrl]
 *
 * Default base URL: http://localhost:3001
 */

const API_KEY_HEADER = 'x-api-key';

function normalizeBase(url: string): string {
  return url.replace(/\/$/, '');
}

async function probe(label: string, url: string, key: string | undefined): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (key) headers[API_KEY_HEADER] = key;

  try {
    const res = await fetch(url, { headers });
    const ok = res.ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label} → ${res.status} ${url}`);
    return ok;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${label} → ${message}`);
    return false;
  }
}

const key = process.env.MANGO_API_KEY?.trim();
if (!key) {
  console.error('Set MANGO_API_KEY to a valid API key.');
  process.exit(1);
}

const base = normalizeBase(
  process.argv[2] ?? process.env.MANGO_API_BASE ?? 'http://localhost:3001'
);
const healthUrl = `${base}/api/health`;
const chatsUrl = `${base}/api/chats`;

const healthOk = await probe('health (no key)', healthUrl, undefined);
const chatsOk = await probe('chats (api key)', chatsUrl, key);

if (healthOk && chatsOk) {
  console.log('External API smoke: all checks passed.');
  process.exit(0);
}

console.error('External API smoke: one or more checks failed.');
process.exit(1);
