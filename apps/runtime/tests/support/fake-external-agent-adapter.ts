import type {
  ExternalAgentCapabilities,
  ExternalAgentEvent,
  ExternalAgentRuntimeDescriptor,
  ExternalNativeSession,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import type {
  ExternalAgentAdapter,
  ExternalAgentApprovalResponseInput,
  ExternalAgentCancelInput,
  ExternalAgentCloseInput,
  ExternalAgentListSessionsInput,
  ExternalAgentOpenSessionInput,
  ExternalAgentStartReviewInput,
  ExternalAgentStartTurnInput,
  ExternalAgentSteerInput,
  ExternalAgentSteerOutcome,
  ExternalAgentTurnStream,
} from '../../src/services/external-agents/adapter';

export interface FakeExternalAgentOptions {
  readonly events?: readonly ExternalAgentEvent[];
  readonly capabilities?: Partial<ExternalAgentCapabilities>;
  readonly hangOpen?: boolean;
  readonly hangTurn?: boolean;
  readonly openGate?: Promise<void>;
  readonly closeGate?: Promise<void>;
  readonly nativeTurnId?: string;
  readonly turnError?: Error;
  /** Implements the optional `steer` member, whatever the descriptor advertises. */
  readonly steerable?: boolean;
  /** What `steer` resolves with once `steerable` is set. Defaults to accepted. */
  readonly steerResult?: ExternalAgentSteerOutcome;
  /** Implements the optional `listSessions` member and answers with these rows. */
  readonly listedSessions?: readonly ExternalNativeSession[];
  /** Implements the optional `startReview` member, whatever the descriptor advertises. */
  readonly reviewable?: boolean;
  /** What `startReview` answers as its thread. Defaults to the session's own. */
  readonly reviewThreadId?: string;
  /** Holds `startReview` open, for inspecting what the supervisor did meanwhile. */
  readonly reviewGate?: Promise<void>;
  readonly reviewFailure?: () => Error;
}

/** Scriptable protocol peer. It never knows or launches a production vendor. */
export class FakeExternalAgentAdapter implements ExternalAgentAdapter {
  readonly targetId = 'codex' as const;
  readonly opens: ExternalAgentOpenSessionInput[] = [];
  readonly turns: ExternalAgentStartTurnInput[] = [];
  readonly responses: ExternalAgentApprovalResponseInput[] = [];
  readonly steers: ExternalAgentSteerInput[] = [];
  readonly listings: ExternalAgentListSessionsInput[] = [];
  readonly reviews: ExternalAgentStartReviewInput[] = [];
  readonly cancellations: ExternalAgentCancelInput[] = [];
  readonly closes: ExternalAgentCloseInput[] = [];
  readonly #events: readonly ExternalAgentEvent[];
  readonly #capabilities: ExternalAgentCapabilities;
  readonly #hangOpen: boolean;
  readonly #hangTurn: boolean;
  readonly #openGate?: Promise<void>;
  readonly #closeGate?: Promise<void>;
  readonly #nativeTurnId?: string;
  readonly #turnError?: Error;
  /** Assigned in the constructor, so `typeof adapter.steer` follows the option. */
  steer?: ExternalAgentAdapter['steer'];
  /** Same pattern: presence is what the registry's conformance check reads. */
  listSessions?: ExternalAgentAdapter['listSessions'];
  startReview?: ExternalAgentAdapter['startReview'];

  constructor(options: FakeExternalAgentOptions = {}) {
    this.#events = options.events ?? [{ type: 'completed' }];
    this.#capabilities = {
      ...NO_EXTERNAL_AGENT_CAPABILITIES,
      structuredStreaming: true,
      ...options.capabilities,
    };
    this.#hangOpen = options.hangOpen ?? false;
    this.#hangTurn = options.hangTurn ?? false;
    this.#openGate = options.openGate;
    this.#closeGate = options.closeGate;
    this.#nativeTurnId = options.nativeTurnId;
    this.#turnError = options.turnError;
    if (options.steerable) {
      this.steer = (input) => {
        this.steers.push(input);
        return Promise.resolve(options.steerResult ?? { accepted: true });
      };
    }
    if (options.reviewable) {
      this.startReview = async (input) => {
        this.reviews.push(input);
        const events = this.#events;
        const hang = this.#hangTurn;
        await options.reviewGate;
        const failure = options.reviewFailure?.();
        if (failure) throw failure;
        return {
          // The hub's own handle, exactly as a real adapter reports it.
          nativeTurnId: input.params.clientMessageId,
          reviewThreadId: options.reviewThreadId ?? input.nativeSessionId,
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
            if (hang) await new Promise<never>(() => undefined);
          },
        };
      };
    }
    const listed = options.listedSessions;
    if (listed) {
      this.listSessions = (input) => {
        this.listings.push(input);
        return Promise.resolve({ sessions: listed });
      };
    }
  }

  discover(): Promise<ExternalAgentRuntimeDescriptor> {
    return Promise.resolve({
      targetId: this.targetId,
      installed: true,
      version: 'fixture-1.0',
      authState: 'signed-in',
      capabilities: this.#capabilities,
      supportedConfigurations: [
        {
          level: 'default',
          routing: 'user',
          supported: true,
          unattended: false,
        },
      ],
    });
  }

  async openSession(input: ExternalAgentOpenSessionInput) {
    this.opens.push(input);
    if (this.#hangOpen) return await new Promise<never>(() => undefined);
    await this.#openGate;
    return {
      nativeSessionId: `native-${input.params.sessionId}`,
      resumed: false,
      effectiveConfiguration: input.params.configuration,
      capabilities: this.#capabilities,
    };
  }

  startTurn(input: ExternalAgentStartTurnInput): ExternalAgentTurnStream {
    this.turns.push(input);
    const nativeTurnId = this.#nativeTurnId ?? `turn-${this.turns.length}`;
    const events = this.#events;
    const hang = this.#hangTurn;
    const turnError = this.#turnError;
    return {
      nativeTurnId,
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
        if (turnError) throw turnError;
        if (hang) await new Promise<never>(() => undefined);
      },
    };
  }

  respond(input: ExternalAgentApprovalResponseInput): Promise<void> {
    this.responses.push(input);
    return Promise.resolve();
  }

  cancel(input: ExternalAgentCancelInput): Promise<void> {
    this.cancellations.push(input);
    return Promise.resolve();
  }

  async close(input: ExternalAgentCloseInput): Promise<void> {
    this.closes.push(input);
    await this.#closeGate;
  }
}
