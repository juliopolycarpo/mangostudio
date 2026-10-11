// The smoke inventory is independent of job layout. Expand the workflow's
// matrix and read the commands that actually run each assertion.

type MatrixEntry = Record<string, string>;

export interface SmokeStep {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, string>;
  readonly 'working-directory'?: string;
  readonly 'continue-on-error'?: boolean;
  readonly 'timeout-minutes'?: number | string;
}

export interface SmokeJob {
  readonly env?: Record<string, string>;
  readonly steps?: readonly SmokeStep[];
  readonly strategy?: { readonly matrix: Record<string, string[] | MatrixEntry[]> };
  readonly 'runs-on'?: string;
  readonly 'continue-on-error'?: boolean;
  readonly 'timeout-minutes'?: number;
}

export interface SmokeWorkflow {
  readonly jobs: Record<string, SmokeJob>;
}

/** One sequence of steps a single runner can execute: a matrix case under one set of workflow inputs. */
export interface SmokeLeg {
  readonly name: string;
  readonly matrix: MatrixEntry;
  readonly inputs: Record<string, boolean>;
}

export interface SmokeAssertion {
  readonly id: string;
  readonly job: string;
  readonly matrix: MatrixEntry;
  readonly step: SmokeStep;
  readonly env: Record<string, string>;
}

/** Parse a smoke workflow for its executable assertion inventory. // Usage: parseSmokeWorkflow(yaml) */
export function parseSmokeWorkflow(source: string): SmokeWorkflow {
  return Bun.YAML.parse(source) as SmokeWorkflow;
}

/** Expand both Cartesian and include-only Actions matrices. // Usage: smokeMatrixCases(job) */
export function smokeMatrixCases(job: SmokeJob): MatrixEntry[] {
  const matrix = job.strategy?.matrix;
  if (!matrix) return [{}];
  const axes = Object.entries(matrix).filter(([name]) => name !== 'include');
  const included = (matrix.include ?? []) as MatrixEntry[];
  if (axes.length === 0) return included;

  let cases: MatrixEntry[] = [{}];
  for (const [axis, values] of axes) {
    cases = cases.flatMap((entry) =>
      (values as string[]).map((value) => ({ ...entry, [axis]: value }))
    );
  }
  return cases.map((entry) => {
    const additions = included.filter((addition) =>
      axes.every(([axis]) => addition[axis] === undefined || addition[axis] === entry[axis])
    );
    return Object.assign({}, entry, ...additions);
  });
}

/** Resolve the matrix fields used by smoke step environments. // Usage: smokeStepEnv(job, step, { platform: 'linux-x64' }) */
export function smokeStepEnv(
  job: SmokeJob,
  step: SmokeStep,
  matrix: MatrixEntry
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...job.env, ...step.env }).map(([name, value]) => [
      name,
      String(value).replace(/\$\{\{ matrix\.(\w+) \}\}/g, (_, key: string) => matrix[key] ?? ''),
    ])
  );
}

/** Resolve a positive integer step deadline, following a matrix field to the leg's own value. // Usage: smokeStepTimeout(step, { smoke_timeout: '12' }) */
export function smokeStepTimeout(step: SmokeStep, matrix: MatrixEntry): number | undefined {
  const declared = step['timeout-minutes'];
  if (declared === undefined) return undefined;
  const field = /^\$\{\{ matrix\.(\w+) \}\}$/i.exec(String(declared))?.[1];
  const resolved = field ? contextValue(matrix, field) : declared;
  const minutes = typeof resolved === 'string' && resolved.trim() ? Number(resolved) : resolved;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0) {
    const received = typeof declared === 'string' ? JSON.stringify(declared) : String(declared);
    const resolvedValue =
      typeof resolved === 'string' ? JSON.stringify(resolved) : String(resolved);
    const detail = field ? ` | resolved matrix.${field}: ${resolvedValue}` : '';
    throw new Error(
      `expected step "${step.name}" timeout-minutes to be a positive integer or a matrix field holding one | received: ${received}${detail}`
    );
  }
  return minutes;
}

/** Expand a job into its legs: each matrix case under every `inputs.rebuild` value its steps branch on. // Usage: smokeJobLegs('binary/binary', job) */
export function smokeJobLegs(jobName: string, job: SmokeJob): SmokeLeg[] {
  const branchesOnRebuild = (job.steps ?? []).some((step) =>
    String(step.if ?? '')
      .toLowerCase()
      .includes('inputs.rebuild')
  );
  const modes = branchesOnRebuild ? [false, true] : [undefined];
  return smokeMatrixCases(job).flatMap((matrix) =>
    modes.map((rebuild): SmokeLeg => {
      const mode = rebuild === undefined ? undefined : rebuild ? 'rebuild' : 'prebuilt';
      const labels = [matrix.platform, mode].filter((label) => label !== undefined);
      return {
        name: labels.length ? `${jobName} (${labels.join(', ')})` : jobName,
        matrix,
        inputs: rebuild === undefined ? {} : { rebuild },
      };
    })
  );
}

/** Decide whether a leg can run a step; only a condition proven false on that leg excludes it. // Usage: smokeStepRuns(step, leg) */
export function smokeStepRuns(step: SmokeStep, leg: SmokeLeg): boolean {
  const declared = String(step.if ?? '').trim();
  const condition = /^\$\{\{(.*)\}\}$/s.exec(declared)?.[1] ?? declared;
  const terms = topLevelConjuncts(condition);
  // A top-level `||` or unmatched quote/parenthesis cannot exclude a step.
  if (!terms) return true;
  // One false top-level term decides a conjunction whatever the others are; a
  // parenthesized group or a `steps.*` read is an unknown term and proves nothing.
  return terms.every((term) => {
    const [, negated, scope, field] = /^\s*(!?)\s*(matrix|inputs)\.(\w+)\s*$/i.exec(term) ?? [];
    if (!scope || !field) return true;
    const input = scope.toLowerCase() === 'inputs';
    const resolved = input ? contextValue(leg.inputs, field) : contextValue(leg.matrix, field);
    if (input && resolved === undefined) return true;
    const value = Boolean(resolved);
    return negated ? !value : value;
  });
}

// Actions context names resolve without case, including matrix and input fields.
function contextValue<T>(context: Record<string, T>, field: string): T | undefined {
  const key = Object.keys(context).find((name) => name.toLowerCase() === field.toLowerCase());
  return key === undefined ? undefined : context[key];
}

// Split on `&&` outside parentheses and single-quoted Actions strings. A
// top-level `||` or unmatched quote/parenthesis leaves the condition unknown.
function topLevelConjuncts(condition: string): string[] | undefined {
  const terms: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < condition.length; index += 1) {
    const char = condition[index];
    if (quoted && char === "'" && condition[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (char === "'") {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return undefined;
    if (depth !== 0) continue;
    const operator = condition.slice(index, index + 2);
    if (operator === '||') return undefined;
    if (operator !== '&&') continue;
    terms.push(condition.slice(start, index));
    start = index + 2;
  }
  if (quoted || depth !== 0) return undefined;
  terms.push(condition.slice(start));
  return terms;
}

/** Name a step the way a failure should cite it, falling back for unnamed `uses:` and marker steps. // Usage: smokeStepLabel(step, 0) */
export function smokeStepLabel(step: SmokeStep, index: number): string {
  return step.name ?? step.id ?? step.uses ?? `#${index + 1}`;
}

/** Fail unless every step a leg can run has a deadline and they total below the job's. // Usage: assertSmokeDeadlineBudget('binary/binary', job) */
export function assertSmokeDeadlineBudget(jobName: string, job: SmokeJob): void {
  const jobTimeout = job['timeout-minutes'];
  if (typeof jobTimeout !== 'number' || !Number.isInteger(jobTimeout) || jobTimeout <= 0) {
    const received =
      typeof jobTimeout === 'string' ? JSON.stringify(jobTimeout) : String(jobTimeout);
    throw new Error(
      `expected ${jobName} to declare job timeout-minutes: <positive integer> | received: ${received}`
    );
  }
  for (const leg of smokeJobLegs(jobName, job)) {
    const budget = legDeadlines(job, leg);
    const total = budget.reduce((sum, { minutes }) => sum + minutes, 0);
    if (total < jobTimeout) continue;
    const terms = budget.map(({ label, minutes }) => `${label}=${minutes}`).join(' + ');
    throw new Error(
      `expected ${leg.name} step deadlines to total below the job's timeout-minutes: ${jobTimeout} | received: ${total} (${terms})`
    );
  }
}

function legDeadlines(job: SmokeJob, leg: SmokeLeg): { label: string; minutes: number }[] {
  return (job.steps ?? []).flatMap((step, index) => {
    if (!smokeStepRuns(step, leg)) return [];
    const label = smokeStepLabel(step, index);
    const minutes = smokeStepTimeout(step, leg.matrix);
    if (minutes === undefined) {
      throw new Error(
        `expected ${leg.name} step "${label}" to declare timeout-minutes: <positive integer> | received: undefined`
      );
    }
    return [{ label, minutes }];
  });
}

/** Identify every binary, Docker image and container pairing assertion. // Usage: smokeAssertions({ binary: parsed }) */
export function smokeAssertions(workflows: Record<string, SmokeWorkflow>): SmokeAssertion[] {
  return Object.entries(workflows).flatMap(([workflowName, workflow]) =>
    Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      smokeMatrixCases(job).flatMap((matrix) =>
        assertionsForCase(workflowName, jobName, job, matrix)
      )
    )
  );
}

function assertionsForCase(
  workflowName: string,
  jobName: string,
  job: SmokeJob,
  matrix: MatrixEntry
): SmokeAssertion[] {
  return (job.steps ?? []).flatMap((step) => {
    if (step.if?.includes('matrix.docker_arch') && !matrix.docker_arch) return [];
    const env = smokeStepEnv(job, step, matrix);
    const id = assertionId(step.run ?? '', env);
    return id ? [{ id, job: `${workflowName}/${jobName}`, matrix, step, env }] : [];
  });
}

function assertionId(command: string, env: Record<string, string>): string | undefined {
  if (command.includes('scripts/test-build.ts')) return `binary/${env.PLATFORM}`;
  if (command.includes('scripts/release/smoke-docker-image.sh')) {
    return `docker/${env.VARIANT}/${env.DOCKER_ARCH}`;
  }
  if (command.includes('connect-container-runtime.integration.test.ts')) {
    const platform = /\.mango\/out\/([^/]+)\//.exec(env.MANGO_CONTAINER_E2E_RUNTIME ?? '')?.[1];
    return `container/${env.MANGO_CONTAINER_E2E_ENGINE}/${platform}`;
  }
  return undefined;
}

/** Fail with each missing assertion's name, rather than just a cell count. // Usage: assertSmokeInventory(actual, expected) */
export function assertSmokeInventory(
  actual: readonly SmokeAssertion[],
  expected: readonly string[]
): void {
  const ids = actual.map(({ id }) => id);
  const missing = expected.filter((id) => !ids.includes(id));
  const unexpected = ids.filter((id) => !expected.includes(id));
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (missing.length || unexpected.length || duplicated.length) {
    throw new Error(
      `Smoke assertion inventory mismatch: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}], duplicated [${duplicated.join(', ')}]; expected all ${expected.length} original assertions`
    );
  }
}
