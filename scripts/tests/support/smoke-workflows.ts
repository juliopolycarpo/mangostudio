// The smoke inventory is independent of job layout. Expand the workflow's
// matrix and read the commands that actually run each assertion.

type MatrixEntry = Record<string, string>;

export interface SmokeStep {
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

/** Resolve a step deadline, following a matrix field to the leg's own value. // Usage: smokeStepTimeout(step, { smoke_timeout: '12' }) */
export function smokeStepTimeout(step: SmokeStep, matrix: MatrixEntry): number | undefined {
  const declared = step['timeout-minutes'];
  if (declared === undefined) return undefined;
  const field = /^\$\{\{ matrix\.(\w+) \}\}$/.exec(String(declared))?.[1];
  const minutes = Number(field ? matrix[field] : declared);
  if (!Number.isFinite(minutes)) {
    throw new Error(
      `expected step "${step.name}" timeout-minutes to be a number or a matrix field holding one | received: ${String(declared)}`
    );
  }
  return minutes;
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
