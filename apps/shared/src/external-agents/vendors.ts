/**
 * Who actually owns each external agent, as data.
 *
 * Shared rather than hub-side because the disclosure is rendered by the client
 * and enforced by the server, and both have to name the same company and link
 * the same documents. A second copy on either side would be a disclosure that
 * says one thing and a gate that recorded another.
 *
 * **Not translated, and deliberately not locale-prefixed.** A paraphrased term of
 * service is MangoStudio making a claim about another company's obligations, so
 * the disclosure links these documents and never summarizes them. The URLs stay
 * in their canonical, locale-free form for a related reason: these sites
 * redirect a bare `/policies/terms-of-use/` to the reader's own language, so the
 * un-prefixed link is the one that serves a `pt-BR` user Portuguese. Pinning
 * `en-US` to make a link "resolve" would hard-code English for everybody — the
 * opposite of what the redirect is doing. The vendor and company names are
 * likewise proper nouns, not copy.
 *
 * Do not try to verify these with an automated fetch. `openai.com` answers 403
 * to any non-browser client on **every** path, locale-prefixed or not, so a
 * failed request says nothing about whether a URL is right; a previous review
 * round called these outdated on exactly that evidence and was wrong.
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
  /**
   * The consumer-facing terms, which is what a subscription-backed sign-in is
   * under — the common case for all three CLIs.
   *
   * OpenAI additionally publishes supplemental *service* terms at
   * `/policies/service-terms/` that apply to API and business use. They are not
   * linked because the disclosure names one document per vendor and an API-key
   * user would need a different second link for each of the three; sending
   * everyone to the terms that cover the common case beats sending everyone to
   * two links, one of which does not apply to them.
   */
  readonly termsUrl: string;
  readonly privacyUrl: string;
  /**
   * Whether this vendor's own skills double as `/name` slash commands.
   *
   * Probed live against each CLI, not inferred from docs (see the
   * `vendor-slash-command-behaviour` note this fact was pulled from): Claude
   * Code and Cursor both list every skill under `/` in their own catalog, so
   * a chat with no announced catalog yet can still offer them from the
   * library's scan of the same directories. Codex reads skills into a prompt
   * section instead — nothing there is ever typed as `/name`, and offering
   * one from a directory listing would advertise a command the CLI never
   * registers.
   */
  readonly skillsAreSlashCommands: boolean;
}

export const EXTERNAL_AGENT_VENDORS: Readonly<Record<ExternalAgentTargetId, ExternalAgentVendor>> =
  {
    codex: {
      company: 'OpenAI',
      termsUrl: 'https://openai.com/policies/terms-of-use/',
      privacyUrl: 'https://openai.com/policies/privacy-policy/',
      skillsAreSlashCommands: false,
    },
    cursor: {
      company: 'Anysphere',
      termsUrl: 'https://cursor.com/terms-of-service',
      privacyUrl: 'https://cursor.com/privacy',
      skillsAreSlashCommands: true,
    },
    claude: {
      company: 'Anthropic',
      termsUrl: 'https://www.anthropic.com/legal/consumer-terms',
      privacyUrl: 'https://www.anthropic.com/legal/privacy',
      skillsAreSlashCommands: true,
    },
  };

export function externalAgentVendor(targetId: ExternalAgentTargetId): ExternalAgentVendor {
  return EXTERNAL_AGENT_VENDORS[targetId];
}
