import type {
  ExternalAgentRemedy,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import { ApiError } from './utils';

/** What a terminal `error` chunk carries beyond its sentence and code. */
export interface ExternalRefusalFields {
  readonly error: string;
  readonly code?: string;
  readonly unavailableReason?: ExternalAgentUnavailableReason;
  readonly remedy?: ExternalAgentRemedy;
  readonly requiredVersion?: string;
}

/**
 * An {@link ApiError} for a stream the hub refused for a state of the agent (signed out, not
 * installed, outdated, consent withdrawn), keeping what the chunk said about it.
 *
 * A plain `ApiError` carries only a message and a code, so a caller that threw one for a terminal
 * chunk lost the reason and the remedy the transcript still showed. The extra fields are the
 * hub's, never the vendor's; a caller says them in its own words.
 *
 * @example
 * throw new ExternalRefusalError({ error: 'could not start', unavailableReason: 'not-installed' });
 */
export class ExternalRefusalError extends ApiError {
  readonly unavailableReason: ExternalAgentUnavailableReason;
  readonly remedy: ExternalAgentRemedy | undefined;
  readonly requiredVersion: string | undefined;

  constructor(
    fields: ExternalRefusalFields & { readonly unavailableReason: ExternalAgentUnavailableReason }
  ) {
    super({ error: fields.error, ...(fields.code ? { code: fields.code } : {}) });
    this.name = 'ExternalRefusalError';
    this.unavailableReason = fields.unavailableReason;
    this.remedy = fields.remedy;
    this.requiredVersion = fields.requiredVersion;
  }
}
