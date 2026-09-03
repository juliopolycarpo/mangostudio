/**
 * Pure presentation helpers for the environments surface.
 *
 * Everything here is deliberately free of React so the rules that matter — the
 * effective binary comes first, aliases collapse into one row, a finding always
 * states its consequence — can be asserted directly.
 */

import type {
  InstallAction,
  InstallGuardReason,
  InstallRecipeId,
  InstallRecipePreview,
  LtsStatus,
  PathSource,
  RecipeInput,
  RuntimeFinding,
  RuntimeHealth,
  RuntimeInstallation,
  RuntimeStatus,
  ToolchainChoice,
} from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import type { ToolIdentityKind } from '@mangostudio/shared/tool-identity';
import { toolSubjectKey } from '@mangostudio/shared/tool-identity';
import { formatMessage } from '@/lib/i18n-format';
import type { ResolvedToolIdentity } from './identity/resolve';
import type { InstallChainStep } from './install-chain';

/**
 * Params that name a runtime, agent, or version manager rather than a value,
 * mapped to the identity kind that names the same thing. The param name is what
 * tells us which registry entry a bare id belongs to.
 */
const IDENTIFIER_PARAM_KINDS: Record<string, ToolIdentityKind> = {
  runtime: 'runtime',
  targetId: 'agent',
  consumer: 'agent',
  manager: 'version-manager',
};

/** Params carrying a zero-based PATH index the UI shows one-based. */
const PATH_INDEX_PARAMS = new Set(['effectivePathIndex', 'shadowedPathIndex']);

/**
 * Resolves a runtime, agent target, or version manager id to its product name.
 * Falls back to the raw id so an id added to the contract before its translation
 * degrades to something readable instead of blank.
 */
export function displayName(t: Messages, id: string): string {
  return (t.environments.names as Record<string, string | undefined>)[id] ?? id;
}

/**
 * Custom names by subject key. Injected rather than imported so these helpers
 * stay React-free; `useToolIdentities` is what feeds it.
 */
export type ToolNameLookup = (subjectKey: string) => string | undefined;

/**
 * The name to print for a tool: the user's own name first, then the chain
 * `displayName` already implements. Callers without a lookup keep the old
 * behaviour exactly.
 */
function toolDisplayName(
  t: Messages,
  kind: ToolIdentityKind,
  id: string,
  lookup?: ToolNameLookup
): string {
  return lookup?.(toolSubjectKey(kind, id)) ?? displayName(t, id);
}

/** PATH entries are shown one-based: `PATH #1` is the first directory searched. */
export function pathPosition(pathIndex: number): number {
  return pathIndex + 1;
}

export function ltsLabel(t: Messages, status: LtsStatus): string {
  return t.environments.lts[status];
}

export function healthLabel(t: Messages, health: RuntimeHealth): string {
  return t.environments.status[health];
}

/**
 * The version to print for an installation. `null` means the binary ran but its
 * output did not parse, which every surface renders as a label rather than
 * interpolating an empty value — the one place that decision lives.
 */
export function versionLabel(t: Messages, version: string | null): string {
  return version ?? t.environments.versionUnknown;
}

/**
 * Field-label plus version for agent card subtitles. The unknown-version
 * phrase already names the field, so prefixing `Version` would read as
 * "Version unknown version".
 */
export function prefixedVersionLabel(t: Messages, version: string | null): string {
  const value = versionLabel(t, version);
  return version === null ? value : `${t.environments.agents.versionLabel} ${value}`;
}

export function guardReasonLabel(t: Messages, reason: InstallGuardReason): string {
  return t.environments.install.guardBlocked[reason];
}

/**
 * Renders one finding as a sentence that names its consequence. Identifier
 * params become the tool's effective name, PATH indices become one-based, and
 * an `ltsStatus` param becomes its translated label.
 */
export function describeFinding(
  t: Messages,
  finding: RuntimeFinding,
  lookup?: ToolNameLookup
): string {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(finding.params ?? {})) {
    const identifierKind = IDENTIFIER_PARAM_KINDS[key];
    if (identifierKind) {
      params[key] = toolDisplayName(t, identifierKind, value, lookup);
    } else if (PATH_INDEX_PARAMS.has(key)) {
      const parsed = Number(value);
      params[key] = Number.isFinite(parsed) ? String(pathPosition(parsed)) : value;
    } else if (key === 'ltsStatus') {
      params[key] = ltsLabel(t, value as LtsStatus);
    } else {
      params[key] = value;
    }
  }
  // A code added to the contract before its translation lands must degrade to
  // something readable, exactly as `displayName` does — never crash the page.
  const template = (t.environments.findings as Record<string, string | undefined>)[finding.code];
  return template ? formatMessage(template, params) : finding.code;
}

/** Severity of a finding, which drives both its colour and its sort position. */
export type FindingSeverity = 'fail' | 'warn';

const FAIL_CODES = new Set<RuntimeFinding['code']>([
  'not-found',
  'not-executable',
  'version-below-minimum',
  'version-below-minimum-for',
  'cli-not-installed',
  'version-probe-failed',
]);

export function findingSeverity(finding: RuntimeFinding): FindingSeverity {
  // The analyzer's own severity wins when it set one. An `info` finding is
  // explicitly detail that must not escalate — a stale install below the floor,
  // a floor belonging to a disabled consumer — so it renders and sorts below a
  // fail even though its code is one the table would otherwise promote. Without
  // this, a card could show a green `ok` badge above a red finding row.
  if (finding.severity === 'info') return 'warn';
  return FAIL_CODES.has(finding.code) ? 'fail' : 'warn';
}

/**
 * The one finding a summary card leads with: worst severity first, and among
 * equals the one the probe reported first. A card with room for a single line
 * must spend it on the thing that actually stops the tool from working.
 */
export function worstFinding(findings: readonly RuntimeFinding[]): RuntimeFinding | undefined {
  let worst: RuntimeFinding | undefined;
  for (const finding of findings) {
    if (worst === undefined) {
      worst = finding;
    } else if (findingSeverity(worst) === 'warn' && findingSeverity(finding) === 'fail') {
      worst = finding;
    }
  }
  return worst;
}

export type HealthRollup = Readonly<Record<RuntimeHealth, number>>;

const EMPTY_ROLLUP: HealthRollup = { ok: 0, warn: 0, missing: 0, error: 0 };

/**
 * How many probed things sit in each health state.
 *
 * Counted from the reported `health` rather than from findings, so a runtime
 * that is installed somewhere the shell cannot reach it lands in `warn` here
 * exactly as it does on its own card — the rollup can never be the cheerful
 * summary of a page that says otherwise.
 */
export function healthRollup(
  statuses: readonly (readonly { readonly health: RuntimeHealth }[])[]
): HealthRollup {
  const counts = { ...EMPTY_ROLLUP };
  for (const list of statuses) {
    for (const status of list) counts[status.health] += 1;
  }
  return counts;
}

export interface KeyedFinding {
  readonly key: string;
  readonly finding: RuntimeFinding;
}

/**
 * Findings carry no id and the same code legitimately repeats — two shadowed
 * paths are two findings — so identity is the code plus its params, with a
 * counter only for the genuinely indistinguishable case.
 */
export function keyedFindings(findings: readonly RuntimeFinding[], prefix = ''): KeyedFinding[] {
  const seen = new Map<string, number>();
  return findings.map((finding) => {
    const base = `${prefix}${finding.code}:${JSON.stringify(finding.params ?? {})}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: occurrence === 0 ? base : `${base}#${occurrence}`, finding };
  });
}

/**
 * A group of installations that all resolve to the same binary. `canonical` is
 * the one the rest are symlinks to, and `aliasCount` is how many paths reach it
 * — a symlink chain is one row with an affordance, never several rows.
 */
export interface InstallationGroup {
  readonly canonical: RuntimeInstallation;
  readonly aliases: readonly RuntimeInstallation[];
  /** Total number of paths that reach this binary, the canonical one included. */
  readonly aliasCount: number;
  readonly effective: boolean;
}

/**
 * Collapses aliases and orders the result effective-first, then by PATH
 * position. Input order is never trusted: the API is free to reorder, and
 * "which one runs" has to stay the first thing on screen.
 */
export function groupInstallations(
  installations: readonly RuntimeInstallation[]
): InstallationGroup[] {
  const byRealPath = new Map<string, RuntimeInstallation[]>();
  for (const installation of installations) {
    const existing = byRealPath.get(installation.path);
    if (existing) existing.push(installation);
    else byRealPath.set(installation.path, [installation]);
  }

  const groups: InstallationGroup[] = [];
  for (const members of byRealPath.values()) {
    const canonical = members.find((member) => member.aliasOf === undefined) ?? members[0];
    if (!canonical) continue;
    groups.push({
      canonical,
      aliases: members.filter((member) => member !== canonical),
      aliasCount: members.length,
      effective: members.some((member) => member.effective),
    });
  }

  return groups.sort((left, right) => {
    if (left.effective !== right.effective) return left.effective ? -1 : 1;
    return pathIndexRank(left.canonical) - pathIndexRank(right.canonical);
  });
}

/** Installations outside PATH sort last; they can never be the one that runs. */
function pathIndexRank(installation: RuntimeInstallation): number {
  return installation.pathIndex ?? Number.MAX_SAFE_INTEGER;
}

export interface EffectiveInstallation {
  readonly groups: readonly InstallationGroup[];
  /** The alias group holding the binary that runs, if any installation does. */
  readonly group: InstallationGroup | undefined;
  readonly installation: RuntimeInstallation | undefined;
}

/**
 * Which binary actually runs, and the alias group that reaches it.
 *
 * Array order is never the authority: the `effective` flag is, and after
 * aliases collapse the grouped view is what carries it. The status's own
 * `effective` field stays the fallback for a payload that flags nothing.
 */
export function effectiveInstallation(status: RuntimeStatus): EffectiveInstallation {
  const groups = groupInstallations(status.installations);
  const group = groups.find((candidate) => candidate.effective);
  return { groups, group, installation: group?.canonical ?? status.effective };
}

/**
 * The catalog entry that performs one action for one runtime. Undefined means
 * the action is not offered here, which every caller renders as "no button"
 * rather than as a disabled one.
 *
 * The catalog can list more than one recipe for the same runtime and action —
 * a POSIX entry and a Windows entry for the same Node install, for instance —
 * so a `supported` match (one whose platforms include this machine) always
 * wins over one that would only ever render as "unsupported on this platform".
 */
export function findInstallRecipe(
  recipes: readonly InstallRecipePreview[],
  runtimeId: string,
  action: InstallAction
): InstallRecipePreview | undefined {
  let unsupportedMatch: InstallRecipePreview | undefined;
  for (const recipe of recipes) {
    if (recipe.runtimeId !== runtimeId || recipe.action !== action) continue;
    if (recipe.supported) return recipe;
    unsupportedMatch ??= recipe;
  }
  return unsupportedMatch;
}

/** Human-readable byte count for the installer download disclosure. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

/** Elapsed install time, rounded to something a human reads at a glance. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * `useToolIdentities().resolve`, named structurally so this module keeps its
 * React-free imports.
 */
export type IdentityResolver = (
  kind: ToolIdentityKind,
  id: string,
  fallbackName?: string
) => ResolvedToolIdentity;

/**
 * Runtime ids as the product names a person reads, joined into one clause.
 *
 * Every sentence that names a set of runtimes — a missing requirement, a
 * chain's prerequisites — reads them the same way, so the wording lives here
 * rather than being rebuilt at each call site.
 */
export function runtimeNameList(resolve: IdentityResolver, ids: readonly string[]): string {
  return ids.map((id) => resolve('runtime', id).name).join(', ');
}

/**
 * "Step 2 of 3 · Node.js" — one wording for a chain's position, shared by the
 * confirmation that lists the steps and the console that runs them.
 *
 * `index` is zero-based; what the user reads is not.
 */
export function chainStepLabel(t: Messages, index: number, count: number, name: string): string {
  return formatMessage(t.environments.install.chainStep, {
    index: String(index + 1),
    count: String(count),
    name,
  });
}

/** Where an installation's binary came from, read straight off `pathSource`. */
export function pathSourceLabel(t: Messages, source: PathSource | undefined): string {
  return t.environments.pathSources[source ?? 'system'];
}

/**
 * The recipe ids that install a fresh Node, in the order this machine's
 * catalog is tried: nvm and fnm both need an explicit version, so neither can
 * stand in as a `findInstallRecipe(..., 'install')` prerequisite — only
 * `winget.node.install` has that shape. Ordering nvm before fnm is arbitrary
 * between two equally good choices; winget last because it is Windows-only
 * and everything before it, if present, is preferred.
 */
const NODE_INSTALL_RECIPE_IDS: readonly InstallRecipeId[] = [
  'nvm.node.install',
  'fnm.node.install',
  'winget.node.install',
];

/** The `RecipeInput` a Node recipe needs, derived from its own declared shape. */
function nodeRecipeInput(recipe: InstallRecipePreview): RecipeInput {
  return recipe.inputKind === 'node-version'
    ? { kind: 'node-version', version: 'lts' }
    : { kind: 'none' };
}

/**
 * The step that installs a first Node on this machine, or undefined when the
 * catalog offers none here — a disconnected environment, or a platform this
 * hub has no recipe for at all.
 */
export function nodeInstallStep(
  recipes: readonly InstallRecipePreview[]
): InstallChainStep | undefined {
  for (const id of NODE_INSTALL_RECIPE_IDS) {
    const recipe = recipes.find((candidate) => candidate.id === id && candidate.supported);
    if (recipe) return { recipe, input: nodeRecipeInput(recipe) };
  }
  return undefined;
}

/**
 * The recipe chain that moves an nvm- or fnm-managed Node to a newer LTS *and*
 * makes it the one that actually runs. Installing a new version alone is not
 * enough for either manager: nvm's `nvm install` does not touch the `default`
 * alias, and fnm's `fnm install` only writes the `lts-latest` alias that
 * `fnm.node.set-default` still has to be pointed at — so the install step
 * always carries its set-default step as a follow-up, never on its own.
 */
const NODE_UPDATE_CHAIN_BY_SOURCE: Partial<
  Record<PathSource, readonly [InstallRecipeId, InstallRecipeId] | readonly [InstallRecipeId]>
> = {
  nvm: ['nvm.node.install', 'nvm.node.set-default'],
  fnm: ['fnm.node.install', 'fnm.node.set-default'],
  winget: ['winget.node.update'],
};

export type NodeUpdateAffordance =
  /** The install step runs first; `followUp` completes it (making the version effective). */
  | {
      readonly kind: 'steps';
      readonly primary: InstallChainStep;
      readonly followUp: readonly InstallChainStep[];
    }
  /** A manager MangoStudio does not drive owns this Node; nothing here can update it. */
  | { readonly kind: 'managed-elsewhere'; readonly source: PathSource }
  /** No effective installation to update, or nothing in the catalog reaches it. */
  | { readonly kind: 'none' };

/**
 * Which "Update Node" affordance applies, decided once here so the card, the
 * setup checklist, and their tests never re-derive it from `pathSource` on
 * their own.
 */
export function nodeUpdateAffordance(
  status: RuntimeStatus,
  recipes: readonly InstallRecipePreview[]
): NodeUpdateAffordance {
  const { installation } = effectiveInstallation(status);
  if (!installation) return { kind: 'none' };

  const source: PathSource = installation.pathSource ?? 'system';
  const chainIds = NODE_UPDATE_CHAIN_BY_SOURCE[source];
  if (!chainIds) return { kind: 'managed-elsewhere', source };

  const steps: InstallChainStep[] = [];
  for (const id of chainIds) {
    const recipe = recipes.find((candidate) => candidate.id === id);
    // The catalog does not offer this step here (an off-platform recipe id,
    // or a stale list) — nothing this rule can build is trustworthy.
    if (!recipe) return { kind: 'none' };
    steps.push({ recipe, input: nodeRecipeInput(recipe) });
  }

  const [primary, ...followUp] = steps;
  if (!primary) return { kind: 'none' };
  return { kind: 'steps', primary, followUp };
}

/**
 * The product name to print for "Managed by {manager}, not by MangoStudio."
 * `volta` resolves through the same identity registry every other version
 * manager does; the rest are not version managers at all, so they read their
 * name from the product dictionary instead.
 *
 * Never called for `'system'`: "Managed by {manager}" cannot carry a bare
 * "the system" without an article ("por o sistema" is not Portuguese), so
 * that source gets its own full sentence — `runtimes.managedBySystem` —
 * chosen at the call site before this function is reached.
 */
export function pathSourceManagerName(
  t: Messages,
  resolve: IdentityResolver,
  source: PathSource
): string {
  if (source === 'volta') return resolve('version-manager', 'volta').name;
  if (source === 'bun') return displayName(t, 'bun');
  if (source === 'mangostudio-managed') return displayName(t, 'mangostudio');
  return displayName(t, source);
}

/** The two runtimes a toolchain pin can name — `ToolchainSelectionSchema`'s own keys. */
export type ToolchainRuntimeId = 'node' | 'bun';

/** Whether `id` is one this card offers a toolchain pin for. Never fnm, nvm, winget, or an agent. */
export function toolchainRuntimeId(id: RuntimeStatus['id']): ToolchainRuntimeId | undefined {
  return id === 'node' || id === 'bun' ? id : undefined;
}

/**
 * "Processes run …" — what a spawned shell, terminal, vendor agent, or
 * installer actually gets on PATH, as opposed to the "Effective" section
 * above it, which is what this machine's own shell resolves right now. On
 * `auto` the two agree, so this reads the same effective installation; on a
 * pin, it reads whichever installation the choice names, wherever that sits
 * on PATH.
 *
 * `undefined` when there is nothing to say: `auto` with no effective binary
 * at all.
 */
export function toolchainProcessLine(
  t: Messages,
  resolve: IdentityResolver,
  status: RuntimeStatus,
  selection: ToolchainChoice
): string | undefined {
  if (selection === 'auto') {
    const { installation } = effectiveInstallation(status);
    if (!installation) return undefined;
    const source = installation.pathSource ?? 'system';
    return source === 'system'
      ? formatMessage(t.environments.runtimes.toolchainAutoSystem, {
          version: versionLabel(t, installation.version),
        })
      : formatMessage(t.environments.runtimes.toolchainAuto, {
          version: versionLabel(t, installation.version),
          source: pathSourceManagerName(t, resolve, source),
        });
  }

  // Aliases share `canonical.path`, so the pin's own path resolves to the
  // group's canonical entry — the same one "Use this version" wrote when it
  // read `installation.path` off this same group.
  const canonical = groupInstallations(status.installations).find(
    (group) => group.canonical.path === selection
  )?.canonical;
  return formatMessage(t.environments.runtimes.toolchainPinned, {
    version: versionLabel(t, canonical?.version ?? null),
    path: canonical?.rawPath ?? selection,
  });
}

/**
 * "Node {version} ({source}) · Bun {version}" for the entities overview: what
 * this machine's shell resolves for each runtime, at a glance.
 *
 * `undefined` while runtime statuses have not loaded yet — the line waits
 * rather than guessing at a machine it has not heard from. Once loaded, a
 * runtime with no effective installation reads as not installed instead of
 * disappearing, so the line never silently drops one half of the pair.
 */
export function toolchainSummary(
  t: Messages,
  statuses: readonly RuntimeStatus[] | undefined
): string | undefined {
  if (statuses === undefined) return undefined;

  const node = statuses.find((status) => status.id === 'node');
  const bun = statuses.find((status) => status.id === 'bun');
  const nodeInstallation = node && effectiveInstallation(node).installation;
  const bunInstallation = bun && effectiveInstallation(bun).installation;

  // The compact form ("Node", not the `names` dictionary's "Node.js") to
  // match the installed branch's own template below.
  const nodePart = nodeInstallation
    ? formatMessage(t.environments.entities.toolchainSummaryNode, {
        version: versionLabel(t, nodeInstallation.version),
        source: pathSourceLabel(t, nodeInstallation.pathSource),
      })
    : formatMessage(t.environments.entities.toolchainSummaryMissing, { runtime: 'Node' });

  const bunPart = bunInstallation
    ? formatMessage(t.environments.entities.toolchainSummaryBun, {
        version: versionLabel(t, bunInstallation.version),
      })
    : formatMessage(t.environments.entities.toolchainSummaryMissing, { runtime: 'Bun' });

  return `${nodePart} · ${bunPart}`;
}
