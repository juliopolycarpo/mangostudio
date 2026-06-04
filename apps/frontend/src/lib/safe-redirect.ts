/**
 * Normalizes a redirect target to a safe app-internal path.
 * Rejects external URLs, protocol-relative paths, and non-absolute paths.
 */
// ASCII control characters. Browsers and the URL parser strip these, so a
// redirect like "/\n/evil.com" would otherwise pass the protocol-relative
// guard below yet resolve to "//evil.com" once the newline is removed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export function safeRedirect(raw: string | undefined | null): string {
  if (!raw) return '/';
  const normalized = raw.trim().replace(CONTROL_CHARS, '');
  if (!normalized) return '/';
  // Only allow paths that start with / (app-internal navigation)
  if (normalized.startsWith('/')) {
    // Reject protocol-relative URLs like "//evil.com/phishing". Browsers
    // normalize backslashes to slashes, so "/\evil.com" is equally unsafe.
    if (normalized[1] === '/' || normalized[1] === '\\') return '/';
    return normalized;
  }
  // Parse as absolute URL — only allow same-origin targets
  try {
    const url = new URL(normalized);
    if (url.origin !== window.location.origin) return '/';
    return url.pathname + url.search + url.hash || '/';
  } catch {
    // Not a valid absolute URL and not an absolute path — reject
    return '/';
  }
}
