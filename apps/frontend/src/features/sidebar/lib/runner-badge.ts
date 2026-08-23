/**
 * Harness attribution for a session row: a short mono label plus the identity
 * dot color from the `--color-agent-*` tokens. Labels come in from i18n so the
 * mapping stays pure and the strings stay in the locale files.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';

export interface RunnerBadgeLabels {
  mango: string;
  codex: string;
  claude: string;
  cursor: string;
}

export interface RunnerBadge {
  label: string;
  /** Tailwind background utility for the harness identity dot. */
  dotClassName: string;
}

const EXTERNAL_DOTS: Record<string, string> = {
  codex: 'bg-agent-codex',
  claude: 'bg-agent-claude',
  cursor: 'bg-agent-cursor',
};

export function runnerBadge(
  runner: ChatRunnerConfiguration,
  labels: RunnerBadgeLabels
): RunnerBadge {
  if (runner.kind === 'mangostudio') {
    return { label: labels.mango, dotClassName: 'bg-agent-mango' };
  }
  // A target this bundle predates still gets a row: its raw id and the
  // generic dot, instead of a crash or a blank.
  return {
    label: labels[runner.targetId] ?? runner.targetId,
    dotClassName: EXTERNAL_DOTS[runner.targetId] ?? 'bg-agent-generic',
  };
}
