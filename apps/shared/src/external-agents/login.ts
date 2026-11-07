/** Literal login launch metadata; the Rust PTY host reads this same descriptor. */
import type { RuntimeCapabilityManifest } from '../runtime-contract/manifest';
import login from './login.json';
import type { ExternalAgentTargetId } from './schemas';

/** Display text only; execution always consumes the descriptor's separate argv. */
export function externalAgentLoginCommand(target: ExternalAgentTargetId): string {
  const descriptor = login[target];
  return [descriptor.program, ...descriptor.args].join(' ');
}

/** Older peers retain the existing command-copy action and receive no new fields. */
export function externalAgentLoginAction(
  target: ExternalAgentTargetId,
  manifest: Pick<RuntimeCapabilityManifest, 'terminal' | 'terminalLoginArgv'>
): { kind: 'terminal'; loginTarget: ExternalAgentTargetId } | { kind: 'copy'; command: string } {
  return manifest.terminal === true && manifest.terminalLoginArgv === true
    ? { kind: 'terminal', loginTarget: target }
    : { kind: 'copy', command: externalAgentLoginCommand(target) };
}
