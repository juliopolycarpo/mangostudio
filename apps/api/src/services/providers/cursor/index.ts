/**
 * Cursor, deprecated as a MangoStudio-owned provider.
 *
 * Cursor was reachable two ways with inverted ownership: as a provider where
 * MangoStudio picked the model, declared the tools, executed them and enforced
 * permissions; and as an external agent where Cursor does all of that itself.
 * One vendor in one selector with opposite semantics is how a tool ends up
 * executed by whichever side assumed the other owned it. The external path is
 * the supported one — it uses the user's own login, inherits their rules and
 * MCP configuration, needs no Node.js and ships none of Cursor's bytes.
 *
 * What is left here is a registration, not an implementation. It exists so a
 * chat still carrying a `cursor/*` model id resolves to a provider that can be
 * named rather than to an unknown-provider crash. Execution never reaches these
 * methods in practice: the deprecation guard in `resolveModel` refuses the turn
 * before provider resolution. They throw anyway, because "unreachable" is a
 * claim about today's callers and this file outlives them.
 *
 * Connectors and their stored secrets are deliberately untouched.
 */

import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ModelInfo,
  StreamingChunk,
  TextGenerationRequest,
  TextGenerationResult,
} from '../types';

const DEPRECATION_MESSAGE =
  'MangoStudio no longer runs Cursor models. Continue in a new chat with the Cursor CLI runner.';

export class CursorProviderDeprecatedError extends Error {
  constructor() {
    super(DEPRECATION_MESSAGE);
    this.name = 'CursorProviderDeprecatedError';
  }
}

function refuse(): never {
  throw new CursorProviderDeprecatedError();
}

const cursorProvider: AIProvider = {
  providerType: 'cursor',

  generateText(_req: TextGenerationRequest): Promise<TextGenerationResult> {
    return refuse();
  },

  generateAgentTurnStream(_req: AgentTurnRequest): AsyncIterable<AgentEvent> {
    return refuse();
  },

  generateTextStream(_req: TextGenerationRequest): AsyncIterable<StreamingChunk> {
    return refuse();
  },

  /**
   * Empty rather than absent. The unified catalog already skips deprecated
   * providers, so this is the second answer to the same question — and the one
   * that holds if some other caller ever lists a provider directly.
   */
  // biome-ignore lint/suspicious/useAwait: satisfies the AIProvider contract
  async listModels(_userId: string): Promise<ModelInfo[]> {
    return [];
  },

  healthcheck(): Promise<void> {
    return refuse();
  },

  validateApiKey(_apiKey: string): Promise<void> {
    return refuse();
  },

  resolveApiKey(_userId: string, _modelName?: string): Promise<string> {
    return refuse();
  },
};

export { cursorProvider };
