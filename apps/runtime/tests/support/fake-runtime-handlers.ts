import { RUNTIME_CONTRACT, type RuntimeMethod } from '@mangostudio/shared/runtime-contract';
import type { RuntimeHandlers } from '../../src/handlers';

/** What a gated call did, in the order the gate let it happen. */
export interface FakeHandlerCall {
  readonly method: RuntimeMethod;
  readonly params: unknown;
}

type FakeHandler = (params: unknown, context: { readonly signal: AbortSignal }) => unknown;

/**
 * A complete contract handler map whose methods do nothing but record.
 *
 * The gate wraps every method, so a partial map would not type-check and a
 * hand-written one would have to be edited on every contract change. This
 * builds one from the contract itself and lets a test replace only the methods
 * it cares about.
 *
 * @example
 * const handlers = new FakeRuntimeHandlers({ 'shell.run': () => ({ exitCode: 0 }) });
 * const gated = gateHandlers(handlers.map, { consent, isUpdateActive: () => false });
 */
export class FakeRuntimeHandlers {
  readonly calls: FakeHandlerCall[] = [];
  readonly map: RuntimeHandlers;

  constructor(overrides: Partial<Record<RuntimeMethod, FakeHandler>> = {}) {
    const entries = Object.keys(RUNTIME_CONTRACT.definition.methods).map((name) => {
      const method = name as RuntimeMethod;
      const override = overrides[method];
      const handle: FakeHandler = (params, context) => {
        this.calls.push({ method, params });
        return override ? override(params, context) : { ok: true };
      };
      return [method, handle];
    });
    this.map = Object.fromEntries(entries) as unknown as RuntimeHandlers;
  }

  methods(): readonly RuntimeMethod[] {
    return this.calls.map((call) => call.method);
  }
}
