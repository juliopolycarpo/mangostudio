// Which lane set a pull request runs: `full`, or `light` for a manifest-only
// Dependabot pull request that has not asked for the full run.
//
// Dependabot pull requests are rolled up into one human-authored pull request
// rather than merged, so the full fan-out (distribution builds for eight
// targets, binary and container smoke, the release dry run, macOS and Windows
// Rust lanes) buys little on each of them. Light mode drops those lanes, and
// every gate that sits on a lightened workflow refuses in light mode
// (scripts/ci/evaluate-gate.ts), so a light run can never merge.
//
// Dependency-free (Node built-ins and sibling libs only): Preflight and the
// sibling `changes` jobs run it before `bun install`.

/** The author a pull request must have for light mode to be considered. */
export const DEPENDABOT_LOGIN = 'dependabot[bot]';

/** Label that restores the full lane set. Read at run time, never from a `labeled` trigger. */
export const FULL_RUN_LABEL = 'ci: full';

/** What a light-mode gate says instead of passing. The sentence names the reason and the recovery. */
export const LIGHT_REFUSAL = `light lane set for a Dependabot pull request; add the ${FULL_RUN_LABEL} label and ask Dependabot to rebase to run the full set`;

const LANE_SETS = ['full', 'light'] as const;
export type LaneSet = (typeof LANE_SETS)[number];

export type DependabotEcosystem = 'bun' | 'cargo' | 'github-actions';

/** Ecosystems whose bumps get the light lane set, with the only paths such a bump may touch. */
const LIGHT_ECOSYSTEM_PATHS: Readonly<Record<DependabotEcosystem, RegExp>> = {
  bun: /^(?:package\.json|bun\.lock|(?:apps|packages)\/[^/]+\/package\.json)$/,
  cargo:
    /^(?:Cargo\.(?:toml|lock)|crates\/[^/]+\/Cargo\.toml|crates\/mango-protocol\/fuzz\/Cargo\.(?:toml|lock))$/,
  'github-actions': /^\.github\/(?:workflows\/[^/]+|actions\/[^/]+\/action)\.ya?ml$/,
};

/** Dependabot's docker ecosystem matches any file name containing "dockerfile". */
const DOCKER_PATH = /(?:^|\/)[^/]*dockerfile[^/]*$/i;

export interface LaneModeContext {
  /** `github.event_name`. */
  readonly eventName: string;
  /** `github.event.pull_request.user.login`: the PR author, not `github.actor`, which follows whoever pushes or re-runs. */
  readonly author: string;
  /** `github.event.pull_request.head.repo.full_name`. */
  readonly headRepo: string;
  /** `github.repository`. */
  readonly baseRepo: string;
}

export interface LaneModeVerdict {
  readonly laneSet: LaneSet;
  /** One line, logged by Preflight so a maintainer can see why a run was light or full. */
  readonly reason: string;
}

const full = (reason: string): LaneModeVerdict => ({ laneSet: 'full', reason });

/** Why a run is full before any label or path is read, or null when light mode is still possible. */
function ineligibleReason(context: LaneModeContext): string | null {
  if (context.eventName !== 'pull_request') {
    return `not a pull_request event (${context.eventName || 'unset'}): full lane set`;
  }
  if (context.author !== DEPENDABOT_LOGIN) {
    return `pull request author ${context.author || 'unknown'} is not ${DEPENDABOT_LOGIN}: full lane set`;
  }
  if (context.headRepo === '' || context.headRepo !== context.baseRepo) {
    return `head repository ${context.headRepo || 'unknown'} is not ${context.baseRepo || 'the base repository'}: full lane set`;
  }
  return null;
}

type PathClass = DependabotEcosystem | 'docker' | 'other';

function classifyPath(path: string): PathClass {
  for (const [ecosystem, pattern] of Object.entries(LIGHT_ECOSYSTEM_PATHS)) {
    if (pattern.test(path)) return ecosystem as DependabotEcosystem;
  }
  return DOCKER_PATH.test(path) ? 'docker' : 'other';
}

/**
 * The one ecosystem a manifest-only diff belongs to, or the reason it is not
 * eligible for light mode. A path outside the ecosystem manifests (a
 * maintainer's fix commit on the Dependabot branch, say) makes the diff
 * eligible for nothing: the dropped lanes could then be the only ones that
 * would have caught that change.
 *
 * @example
 * classifyDependabotDiff(['Cargo.lock']); // { ecosystem: 'cargo' }
 */
export function classifyDependabotDiff(
  paths: readonly string[]
): { readonly ecosystem: DependabotEcosystem } | { readonly reason: string } {
  const classes = paths.map((path) => [path, classifyPath(path)] as const);
  const other = classes.find(([, kind]) => kind === 'other');
  if (other) {
    return {
      reason: `diff touches ${other[0]}, which is not a dependency manifest: full lane set`,
    };
  }
  const kinds = [...new Set(classes.map(([, kind]) => kind))];
  if (kinds.length !== 1) {
    return { reason: `diff mixes ${kinds.sort().join(', ')}: full lane set` };
  }
  const [kind] = kinds as [PathClass];
  if (kind === 'docker') {
    // Smoke Container is the one lane that builds the Dockerfiles, and light
    // mode drops it, so a light run would say nothing about a docker bump.
    return {
      reason:
        'docker ecosystem: the distribution and container smoke lanes are its only validation: full lane set',
    };
  }
  return { ecosystem: kind as DependabotEcosystem };
}

/**
 * Pure classification: author x label x ecosystem to a lane set and a reason.
 *
 * @example
 * classifyLaneMode(
 *   { eventName: 'pull_request', author: 'dependabot[bot]', headRepo: 'o/r', baseRepo: 'o/r' },
 *   [],
 *   ['bun.lock', 'package.json']
 * ); // { laneSet: 'light', reason: 'Dependabot bun manifest-only diff: light lane set' }
 */
export function classifyLaneMode(
  context: LaneModeContext,
  labels: readonly string[],
  paths: readonly string[]
): LaneModeVerdict {
  const early = ineligibleReason(context);
  if (early) return full(early);
  if (labels.some((label) => label.toLowerCase() === FULL_RUN_LABEL)) {
    return full(`${FULL_RUN_LABEL} label present: full lane set`);
  }
  const diff = classifyDependabotDiff(paths);
  if ('reason' in diff) return full(diff.reason);
  return {
    laneSet: 'light',
    reason: `Dependabot ${diff.ecosystem} manifest-only diff without the ${FULL_RUN_LABEL} label: light lane set`,
  };
}

export interface LaneModeSources {
  /** The pull request's labels at run time. May reject. */
  readonly readLabels: () => Promise<readonly string[]>;
  /** The diff's changed paths; throws on an empty or invalid diff, like every other adapter. */
  readonly readPaths: () => readonly string[];
}

/**
 * Orchestrates {@link classifyLaneMode}. A human or non-pull-request run
 * decides without calling either source, so it costs no API request and
 * cannot be affected by one. A label read that fails yields `full`: the run
 * cannot prove the label is absent.
 */
export async function decideLaneMode(
  context: LaneModeContext,
  sources: LaneModeSources
): Promise<LaneModeVerdict> {
  const early = ineligibleReason(context);
  if (early) return full(early);

  let labels: readonly string[];
  try {
    labels = await sources.readLabels();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return full(
      `label read failed (${detail}); cannot show ${FULL_RUN_LABEL} is absent: full lane set`
    );
  }
  return classifyLaneMode(context, labels, sources.readPaths());
}

/**
 * Parse a gate's `LANE_SET`. An absent variable is `full` (a gate that is not
 * lane-aware); a present one must be exactly `full` or `light`, so an empty or
 * misspelled output from `changes` fails the gate instead of passing it.
 */
export function parseLaneSet(raw: string | undefined): LaneSet {
  if (raw === undefined) return 'full';
  if ((LANE_SETS as readonly string[]).includes(raw)) return raw as LaneSet;
  throw new Error(
    `LANE_SET must be one of ${LANE_SETS.join(' | ')} | received: ${JSON.stringify(raw)}`
  );
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Read the pull request's current labels from the API. The event payload is
 * frozen when the event is created and a re-run reuses it, so only this read
 * sees a label added afterwards. `pull-requests: read` is enough, and a
 * Dependabot `pull_request` token may hold it.
 */
export async function readPullRequestLabels(options: {
  readonly repository: string;
  readonly pullNumber: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetchImpl: FetchLike;
}): Promise<readonly string[]> {
  if (!REPOSITORY_PATTERN.test(options.repository) || !/^[1-9][0-9]*$/.test(options.pullNumber)) {
    throw new Error(
      `expected repository owner/name and a positive pull number | received: ${JSON.stringify(options.repository)} #${JSON.stringify(options.pullNumber)}`
    );
  }
  if (!options.token) throw new Error('GH_TOKEN is empty');
  const url = `${options.apiUrl ?? 'https://api.github.com'}/repos/${options.repository}/pulls/${options.pullNumber}`;
  const response = await options.fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GET ${url} responded ${response.status}`);
  const body = (await response.json()) as { labels?: unknown };
  if (
    !Array.isArray(body.labels) ||
    !body.labels.every((label) => typeof (label as { name?: unknown })?.name === 'string')
  ) {
    throw new Error(`GET ${url} returned no labels array of named labels`);
  }
  return body.labels.map((label) => (label as { name: string }).name);
}
