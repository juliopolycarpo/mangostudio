/**
 * The narrow slice of `RuntimeClient` this module depends on.
 *
 * A structural subset rather than the concrete class, so a `FakeRuntimeClient`
 * in tests can stand in for it without extending or mocking the real facade —
 * `RuntimeClient` itself satisfies this shape.
 *
 * Projected from `RuntimeClient` rather than retyped, so a signature that moves
 * on the facade cannot leave a structurally-satisfied copy behind here: the
 * service would keep compiling against a shape the runtime no longer speaks and
 * fail only at the wire.
 */

import type { RuntimeClient } from '../../../services/runtime-client/runtime-client';

export type TerminalRuntimeTerminalClient = RuntimeClient['terminal'];

export type TerminalRuntimeClient = Pick<RuntimeClient, 'manifest' | 'terminal' | 'onClose'>;
