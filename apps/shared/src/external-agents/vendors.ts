/**
 * Who actually owns each external agent, as data.
 *
 * Shared rather than hub-side because the disclosure is rendered by the client
 * and enforced by the server, and both have to name the same company and link
 * the same documents. A second copy on either side would be a disclosure that
 * says one thing and a gate that recorded another.
 *
 * **Not translated.** A localized URL is a different URL, and a paraphrased term
 * of service is MangoStudio making a claim about another company's obligations.
 * The disclosure links these documents; it never summarizes them. The vendor and
 * company names are likewise proper nouns, not copy.
 *
 * Branding is nominative use only: the name identifies the tool being launched.
 * No logos, no wordmarks, and nothing implying an official, endorsed or partner
 * integration.
 *
 * Browser-safe: no Node builtins.
 */

import type { ExternalAgentTargetId } from './schemas';

export interface ExternalAgentVendor {
  /** The company behind the CLI, which is who the terms are with. */
  readonly company: string;
  readonly termsUrl: string;
  readonly privacyUrl: string;
}

export const EXTERNAL_AGENT_VENDORS: Readonly<Record<ExternalAgentTargetId, ExternalAgentVendor>> =
  {
    codex: {
      company: 'OpenAI',
      termsUrl: 'https://openai.com/policies/terms-of-use/',
      privacyUrl: 'https://openai.com/policies/privacy-policy/',
    },
    cursor: {
      company: 'Anysphere',
      termsUrl: 'https://cursor.com/terms-of-service',
      privacyUrl: 'https://cursor.com/privacy',
    },
    claude: {
      company: 'Anthropic',
      termsUrl: 'https://www.anthropic.com/legal/consumer-terms',
      privacyUrl: 'https://www.anthropic.com/legal/privacy',
    },
  };

export function externalAgentVendor(targetId: ExternalAgentTargetId): ExternalAgentVendor {
  return EXTERNAL_AGENT_VENDORS[targetId];
}
