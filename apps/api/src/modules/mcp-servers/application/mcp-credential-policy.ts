/** Credential-safe normalization for portable MCP HTTP URLs. */

import { Buffer } from 'node:buffer';
import { looksCredentialShaped } from '../../../lib/credential-policy';

export { looksCredentialShaped };

export interface AnalyzedMcpHttpUrl {
  /** Canonical URL with userinfo removed and credential query values redacted. */
  normalizedUrl: string;
  /** Basic auth derived from URL userinfo, kept server-side only. */
  embeddedAuthorization?: string;
  /** Query keys whose values cannot be represented safely in the portable format. */
  credentialQueryNames: string[];
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
