export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export function normalizeDeepSeekBaseUrl(baseUrl: string | null | undefined): string {
  return baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_DEEPSEEK_BASE_URL;
}
