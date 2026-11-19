/**
 * Named fake: a terminal runtime client whose `terminal.write` always rejects, the way a real
 * runtime answers `UNAVAILABLE` when it cannot confirm shell consent. Every other call goes to
 * the wrapped fake.
 */

import type { TerminalRuntimeClient } from '../../../src/modules/terminals/domain/terminal-runtime-client';
import type { FakeTerminalRuntimeClient } from './fake-terminal-runtime-client';

export class RefusingTerminalWriteClient implements TerminalRuntimeClient {
  readonly terminal: TerminalRuntimeClient['terminal'];

  constructor(
    private readonly inner: FakeTerminalRuntimeClient,
    reason: string
  ) {
    this.terminal = { ...inner.terminal, write: () => Promise.reject(new Error(reason)) };
  }

  get manifest() {
    return this.inner.manifest;
  }

  onClose(listener: () => void) {
    return this.inner.onClose(listener);
  }
}
