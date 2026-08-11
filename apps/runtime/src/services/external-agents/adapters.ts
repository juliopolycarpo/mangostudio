/**
 * The adapters a production runtime registers.
 *
 * The manifest's `externalAgents` list is derived from the registry, so this
 * function is what a paired hub actually sees this runtime able to host. Tests
 * inject their own set instead, which is why the default is a factory rather
 * than a module-level constant: two hosts in one process must not share adapter
 * state.
 */

import type { ExternalAgentAdapter } from './adapter';
import { ClaudeCodeAdapter } from './claude/adapter';
import { CodexAppServerAdapter } from './codex/adapter';
import { CursorAcpAdapter } from './cursor/adapter';

export function createDefaultExternalAgentAdapters(): readonly ExternalAgentAdapter[] {
  return [new CodexAppServerAdapter(), new CursorAcpAdapter(), new ClaudeCodeAdapter()];
}
