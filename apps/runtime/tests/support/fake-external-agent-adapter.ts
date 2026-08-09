import type {
  ExternalAgentCapabilities,
  ExternalAgentEvent,
  ExternalAgentRuntimeDescriptor,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import type {
  ExternalAgentAdapter,
  ExternalAgentApprovalResponseInput,
  ExternalAgentCancelInput,
  ExternalAgentCloseInput,
  ExternalAgentOpenSessionInput,
  ExternalAgentStartTurnInput,
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
}

/** Scriptable protocol peer. It never knows or launches a production vendor. */
export class FakeExternalAgentAdapter implements ExternalAgentAdapter {
  readonly targetId = 'codex' as const;
  readonly opens: ExternalAgentOpenSessionInput[] = [];
  readonly turns: ExternalAgentStartTurnInput[] = [];
  readonly responses: ExternalAgentApprovalResponseInput[] = [];
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
    if (options.steerable) this.steer = () => Promise.resolve({ accepted: true });
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
