/**
 * OpenAI-compatible endpoint classification.
 * Classifies a base URL to apply endpoint-specific logic (e.g. reasoning extraction).
 */

/** True when `hostname` is `domain` itself or a subdomain of it. */
function isHostWithinDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Classifies the endpoint type from its base URL.
 * Used to apply endpoint-specific reasoning extraction logic and capability flags.
 *
 * Matches the parsed hostname against known provider domains rather than a raw
 * substring, so deceptive URLs like `https://api.deepseek.com.evil.test/v1`
 * classify as `generic` (CodeQL js/incomplete-url-substring-sanitization).
 */
export function classifyEndpoint(baseUrl: string): 'deepseek' | 'openrouter' | 'generic' {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return 'generic';
  }

  if (isHostWithinDomain(hostname, 'deepseek.com')) return 'deepseek';
  if (isHostWithinDomain(hostname, 'openrouter.ai')) return 'openrouter';
  return 'generic';
}
