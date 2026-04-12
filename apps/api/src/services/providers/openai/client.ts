/**
 * OpenAI SDK client factory and auth context types.
 */

import OpenAI, { APIError as OpenAIAPIError } from 'openai';

const BASE_URL = 'https://api.openai.com/v1';

/** All credentials needed to authenticate with the OpenAI API. */
export interface OpenAIAuthContext {
  apiKey: string;
  organizationId?: string | null;
  projectId?: string | null;
}

/** Thrown when OpenAI rejects the key or auth context (HTTP 401 / 403). */
export class OpenAIAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenAIAuthError';
    this.status = status;
  }
}

/** Thrown when the connector configuration is incomplete or malformed. */
export class OpenAIConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAIConfigError';
  }
}

/**
 * Creates an OpenAI SDK client from a full auth context.
 * Passes organization and project so that project-scoped keys work correctly.
 */
export function createOpenAIClient(ctx: OpenAIAuthContext): OpenAI {
  return new OpenAI({
    apiKey: ctx.apiKey,
    baseURL: BASE_URL,
    ...(ctx.organizationId ? { organization: ctx.organizationId } : {}),
    ...(ctx.projectId ? { project: ctx.projectId } : {}),
  });
}

/**
 * Validates an OpenAI auth context by listing models through the SDK.
 * Uses the exact same client construction as runtime so that project/org
 * scoping cannot diverge between validation and generation.
 *
 * @throws {OpenAIAuthError} for 401 / 403 responses.
 * @throws {OpenAIConfigError} for other API errors that indicate bad config.
 */
export async function validateOpenAIAuthContext(ctx: OpenAIAuthContext): Promise<void> {
  const client = createOpenAIClient(ctx);
  try {
    await client.models.list();
  } catch (err) {
    if (err instanceof OpenAIAPIError) {
      if (err.status === 401) {
        throw new OpenAIAuthError(
          'OpenAI API key is invalid or expired. Verify your key and try again.',
          401
        );
      }
      if (err.status === 403) {
        throw new OpenAIAuthError(
          'OpenAI access denied. Check that your organization ID, project ID, and key permissions are correct.',
          403
        );
      }
      throw new OpenAIConfigError(
        `OpenAI connector validation failed (HTTP ${err.status}): ${err.message}`
      );
    }
    throw err;
  }
}
