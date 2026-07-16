/** Credential-shape detection shared by import and secret-free normalization. */

import { Buffer } from 'node:buffer';

const CREDENTIAL_KEY_PATTERN =
  /(?:^|[_-])(api[_-]?key|auth|authorization|credential|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/i;

export interface AnalyzedMcpHttpUrl {
  /** Canonical URL with userinfo removed and credential query values redacted. */
  normalizedUrl: string;
  /** Basic auth derived from URL userinfo, kept server-side only. */
  embeddedAuthorization?: string;
  /** Query keys whose values cannot be represented safely in the portable format. */
  credentialQueryNames: string[];
}

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

export function analyzeMcpHttpUrl(value: string): AnalyzedMcpHttpUrl {
  const url = new URL(value);
  const hasUserInfo = url.username.length > 0 || url.password.length > 0;
  const embeddedAuthorization = hasUserInfo
    ? `Basic ${Buffer.from(`${decodeUserInfo(url.username)}:${decodeUserInfo(url.password)}`).toString('base64')}`
    : undefined;
  url.username = '';
  url.password = '';
  url.hash = '';

  const queryEntries = [...url.searchParams.entries()];
  const credentialQueryNames = [
    ...new Set(
      queryEntries.filter(([name, item]) => looksCredentialShaped(name, item)).map(([name]) => name)
    ),
  ].sort();
  if (credentialQueryNames.length > 0) {
    const credentialNames = new Set(credentialQueryNames);
    url.search = '';
    for (const [name, item] of queryEntries) {
      url.searchParams.append(name, credentialNames.has(name) ? '' : item);
    }
  }
  url.searchParams.sort();

  return {
    normalizedUrl: url.toString(),
    ...(embeddedAuthorization !== undefined && { embeddedAuthorization }),
    credentialQueryNames,
  };
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
