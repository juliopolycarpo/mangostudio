/**
 * The Overview's "Setup" checklist: what a new machine needs before agents can
 * run on it, and the remedy that clears each row.
 *
 * Deliberately free of React, same reason format.ts is: every row's status is
 * a pure function of data the Toolchains, Agents, and This machine tabs
 * already fetch, so the rule is asserted directly rather than through a
 * render. No new endpoint backs this — it is a read of state those tabs
 * already own.
 */

import type {
  AgentCliStatus,
  InstallRecipePreview,
  RuntimeId,
  RuntimeStatus,
} from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import type { MachineStatus } from '@mangostudio/shared/machine';
import { formatMessage } from '@/lib/i18n-format';
import {
  displayName,
  effectiveInstallation,
  nodeInstallStep,
  nodeUpdateAffordance,
} from './format';
import type { InstallChainStep } from './install-chain';

export type SetupRowStatus = 'done' | 'todo' | 'optional';
type SetupRowId = 'git' | 'node' | 'bun' | 'agent' | 'hub-service';

/** A route this checklist links out to; every value is an existing tab. */
type SetupLinkTarget = '/environments/agents' | '/environments/machine' | '/environments/runtimes';

type SetupRemedy =
  | {
      readonly kind: 'install';
      readonly step: InstallChainStep;
      readonly followUp?: readonly InstallChainStep[];
      readonly label: string;
    }
  | { readonly kind: 'link'; readonly to: SetupLinkTarget; readonly label: string }
  | { readonly kind: 'copy'; readonly label: string; readonly value: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'none' };

export interface SetupRow {
  readonly id: SetupRowId;
  readonly status: SetupRowStatus;
  readonly label: string;
  readonly explanation: string;
  readonly remedy: SetupRemedy;
}

const OUTDATED_NODE_CODES = new Set(['outdated-lts', 'version-below-minimum']);

/**
 * Whether the effective Node is flagged stale. Findings are per-status, not
 * per-installation: an old *non-effective* Node also emits these codes, but
 * with `severity: 'info'` — detail a card still lists, never a reason to fail
 * a row that already has a current, effective binary.
 */
function isNodeOutdated(status: RuntimeStatus | undefined): boolean {
  if (!status) return false;
  return status.findings.some(
    (finding) => OUTDATED_NODE_CODES.has(finding.code) && finding.severity !== 'info'
  );
}

function openLinkLabel(t: Messages, section: string): string {
  return formatMessage(t.environments.overview.open, { section });
}

function gitRemedy(
  t: Messages,
  recipes: readonly InstallRecipePreview[],
  platform: string
): SetupRemedy {
  if (platform === 'win32') {
    const recipe = recipes.find((candidate) => candidate.id === 'git.install.windows');
    if (!recipe) return { kind: 'none' };
    return {
      kind: 'install',
      step: { recipe, input: { kind: 'none' } },
      label: formatMessage(t.environments.runtimes.install, { runtime: displayName(t, 'git') }),
    };
  }
  if (platform === 'darwin') {
    return {
      kind: 'copy',
      label: t.environments.overview.setup.gitDarwinRemedy,
      value: 'xcode-select --install',
    };
  }
  return { kind: 'text', text: t.environments.overview.setup.gitLinuxRemedy };
}

/**
 * One runtime's row inputs: the probed status, and whether this machine has
 * an effective installation of it. Every row asks the same two questions, and
 * "installed" means the same thing in all of them.
 */
function effectiveRuntime(
  runtimes: readonly RuntimeStatus[],
  id: RuntimeId
): { status: RuntimeStatus | undefined; installed: boolean } {
  const status = runtimes.find((runtime) => runtime.id === id);
  return { status, installed: Boolean(status && effectiveInstallation(status).installation) };
}

function gitRow(
  t: Messages,
  runtimes: readonly RuntimeStatus[],
  recipes: readonly InstallRecipePreview[],
  platform: string
): SetupRow {
  const { installed } = effectiveRuntime(runtimes, 'git');
  return {
    id: 'git',
    status: installed ? 'done' : 'todo',
    label: t.environments.overview.setup.git.label,
    explanation: t.environments.overview.setup.git.explanation,
    remedy: installed ? { kind: 'none' } : gitRemedy(t, recipes, platform),
  };
}

function nodeRemedy(
  t: Messages,
  status: RuntimeStatus | undefined,
  installed: boolean,
  recipes: readonly InstallRecipePreview[]
): SetupRemedy {
  if (!installed) {
    const step = nodeInstallStep(recipes);
    if (!step) return { kind: 'none' };
    return {
      kind: 'install',
      step,
      label: formatMessage(t.environments.runtimes.install, { runtime: displayName(t, 'node') }),
    };
  }
  if (!status) return { kind: 'none' };
  const affordance = nodeUpdateAffordance(status, recipes);
  if (affordance.kind === 'steps') {
    return {
      kind: 'install',
      step: affordance.primary,
      followUp: affordance.followUp,
      label: formatMessage(t.environments.runtimes.update, { runtime: displayName(t, 'node') }),
    };
  }
  // Managed by a version manager MangoStudio does not drive (Volta, a plain
  // system install): the fix is on the Toolchains tab, not a button here.
  return {
    kind: 'link',
    to: '/environments/runtimes',
    label: openLinkLabel(t, t.environments.tabs.runtimes),
  };
}

function nodeRow(
  t: Messages,
  runtimes: readonly RuntimeStatus[],
  recipes: readonly InstallRecipePreview[]
): SetupRow {
  const { status, installed } = effectiveRuntime(runtimes, 'node');
  const done = installed && !isNodeOutdated(status);
  return {
    id: 'node',
    status: done ? 'done' : 'todo',
    label: t.environments.overview.setup.node.label,
    explanation: t.environments.overview.setup.node.explanation,
    remedy: done ? { kind: 'none' } : nodeRemedy(t, status, installed, recipes),
  };
}

function bunRow(t: Messages, runtimes: readonly RuntimeStatus[]): SetupRow {
  const { installed } = effectiveRuntime(runtimes, 'bun');
  return {
    id: 'bun',
    // Optional either way: Bun never blocks the checklist, it only reports
    // whether this machine already has it.
    status: installed ? 'done' : 'optional',
    label: t.environments.overview.setup.bun.label,
    explanation: t.environments.overview.setup.bun.explanation,
    remedy: { kind: 'none' },
  };
}

function agentRow(t: Messages, agents: readonly AgentCliStatus[]): SetupRow {
  const ready = agents.some((agent) => agent.effective && agent.authenticated);
  return {
    id: 'agent',
    status: ready ? 'done' : 'todo',
    label: t.environments.overview.setup.agent.label,
    explanation: t.environments.overview.setup.agent.explanation,
    remedy: ready
      ? { kind: 'none' }
      : {
          kind: 'link',
          to: '/environments/agents',
          label: openLinkLabel(t, t.environments.tabs.agents),
        },
  };
}

function hubServiceRow(t: Messages, machine: MachineStatus | undefined): SetupRow {
  const running = Boolean(machine?.service.installed && machine.service.running);
  return {
    id: 'hub-service',
    status: running ? 'done' : 'todo',
    label: t.environments.overview.setup.hubService.label,
    explanation: t.environments.overview.setup.hubService.explanation,
    remedy: running
      ? { kind: 'none' }
      : {
          kind: 'link',
          to: '/environments/machine',
          label: openLinkLabel(t, t.environments.tabs.machine),
        },
  };
}

/**
 * Every row of the Overview's setup checklist, in the order a newcomer would
 * clear them. `platform` decides the Git remedy's shape and defaults to the
 * machine status's own report — its absence (a still-loading query) reads as
 * an unknown platform, which degrades to the Linux "your package manager"
 * text rather than guessing.
 */
export function buildSetupRows(
  t: Messages,
  runtimes: readonly RuntimeStatus[],
  agents: readonly AgentCliStatus[],
  recipes: readonly InstallRecipePreview[],
  machine: MachineStatus | undefined
): readonly SetupRow[] {
  const platform = machine?.platform ?? '';
  return [
    gitRow(t, runtimes, recipes, platform),
    nodeRow(t, runtimes, recipes),
    bunRow(t, runtimes),
    agentRow(t, agents),
    hubServiceRow(t, machine),
  ];
}
