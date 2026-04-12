/**
 * OpenAI-compatible endpoint classification.
 * Classifies a base URL to apply endpoint-specific logic (e.g. reasoning extraction).
 */

/**
 * Classifies the endpoint type from its base URL.
 * Used to apply endpoint-specific reasoning extraction logic and capability flags.
 */
export function classifyEndpoint(baseUrl: string): 'deepseek' | 'openrouter' | 'generic' {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('deepseek.com')) return 'deepseek';
  if (lower.includes('openrouter.ai')) return 'openrouter';
  return 'generic';
}
