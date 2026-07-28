const CREDENTIAL_KEY_PATTERN =
  /(?:^|[_-])(api[_-]?key|auth|authorization|credential|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/i;

/** Conservative credential classifier shared by every secret-free projection. */
export function looksCredentialShaped(name: string, value: string): boolean {
  if (CREDENTIAL_KEY_PATTERN.test(name)) return true;
  if (/^(?:basic|bearer)\s+\S+/i.test(value) || value.includes('-----BEGIN PRIVATE KEY-----')) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return parsed.password.length > 0;
  } catch {
    return false;
  }
}
