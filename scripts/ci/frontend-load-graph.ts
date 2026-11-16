#!/usr/bin/env bun
// What a first page load of the frontend downloads and parses, and how many
// serial requests the first use of a lazy feature needs.
//
// `frontend-bundle-report.ts` answers "which files are eager, and how big is
// each". This answers the questions behind it, from `dist/` and the build's
// `dist-metafile.json`:
//
// - the eager payload in raw, gzip and Brotli bytes (Brotli is what the binary
//   serves: `precompress-assets.ts` uses the same encoder settings);
// - which modules and packages make up the eager graph, by bytes in the output;
// - the images and fonts the eager files reference, which no compressor shrinks;
// - how many lazy chunks there are and how many are under 1 KB, because every
//   chunk is a request;
// - for each named feature, the rounds and requests its first use costs. A round
//   is one `import()` that fetches anything: Bun preloads the whole static
//   closure of an `import()` target in parallel (see `fetchStatic`), so what
//   serialises a feature is how many `import()` calls wait on one another.
//
// `--budget <file>` turns the Brotli number into a gate: it exits 1 when the
// eager payload exceeds the limit in the file.
//
// Usage: bun ./scripts/ci/frontend-load-graph.ts [--dist <dir>] [--metafile <file>] [--modules <n>] [--json] [--budget <file>]

import { dirname, join, posix } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { compress } from '../lib/precompress-assets';
import { type BundleFile, formatBytes, measureBundle } from './frontend-bundle-report';

const DEFAULT_DIST_DIR = join(ROOT_DIR, 'apps/frontend/dist');
const DEFAULT_MODULE_ROWS = 25;
/** A chunk this small costs a request for almost no code. */
export const SMALL_CHUNK_BYTES = 1024;

/** The slice of a `Bun.build()` metafile this report reads. */
export interface LoadGraphMetafile {
  readonly inputs: Record<
    string,
    {
      readonly imports: readonly {
        readonly path: string;
        readonly kind: string;
        readonly entryPoint?: string;
      }[];
    }
  >;
  readonly outputs: Record<
    string,
    {
      readonly bytes: number;
      readonly inputs: Record<string, { readonly bytesInOutput: number }>;
      readonly imports: readonly { readonly path: string; readonly kind: string }[];
    }
  >;
}

/** `./assets/x.js` and `assets/x.js` name one file; the metafile uses both forms. */
function outputKey(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * Brotli size through the encoder that builds the hub's precompressed copies,
 * so the number is what a browser that sends `br` downloads from the binary.
 */
export function brotliSize(bytes: Uint8Array<ArrayBuffer>): number {
  return compress('br', bytes).byteLength;
}

export interface EagerFile {
  readonly path: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
}

export interface EagerPayload {
  readonly files: readonly EagerFile[];
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
}

/** Sums the eager files (`index.html`, stylesheets, the entry script and its static imports). */
export async function measureEagerPayload(
  distDir: string,
  files: readonly BundleFile[]
): Promise<EagerPayload> {
  const eager = files.filter((file) => file.eager);
  const brotli = await Promise.all(
    eager.map(async (file) =>
      brotliSize(new Uint8Array(await Bun.file(join(distDir, file.path)).arrayBuffer()))
    )
  );
  const measured = eager.map((file, index) => ({
    path: file.path,
    rawBytes: file.rawBytes,
    gzipBytes: file.gzipBytes,
    brotliBytes: brotli[index] ?? 0,
  }));
  const total = (of: (file: EagerFile) => number): number =>
    measured.reduce((sum, file) => sum + of(file), 0);
  return {
    files: measured.sort((a, b) => b.rawBytes - a.rawBytes || a.path.localeCompare(b.path)),
    rawBytes: total((file) => file.rawBytes),
    gzipBytes: total((file) => file.gzipBytes),
    brotliBytes: total((file) => file.brotliBytes),
  };
}

export interface EagerAsset {
  readonly path: string;
  readonly bytes: number;
}

const ASSET_REFERENCE = /\/(?:assets|fonts)\/[\w.$-]+\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?)/g;

/**
 * Images and fonts that the eager files name: a first paint fetches the image
 * an eager component renders and the fonts the stylesheet and `index.html`
 * point at. They never appear in the metafile outputs, and no compressor
 * shrinks them, so a duplicate or oversized one costs its full size.
 */
export async function measureEagerAssets(
  distDir: string,
  eagerPaths: readonly string[]
): Promise<EagerAsset[]> {
  const referenced = new Set<string>();
  for (const path of eagerPaths) {
    if (!/\.(?:html|css|js)$/.test(path)) continue;
    const text = await Bun.file(join(distDir, path)).text();
    for (const [reference] of text.matchAll(ASSET_REFERENCE)) referenced.add(reference.slice(1));
  }
  const assets: EagerAsset[] = [];
  for (const path of [...referenced].sort()) {
    const file = Bun.file(join(distDir, path));
    if (await file.exists()) assets.push({ path, bytes: file.size });
  }
  return assets;
}

export interface ChunkStats {
  readonly chunks: number;
  readonly smallChunks: number;
  readonly smallChunkBytes: number;
  readonly totalBytes: number;
}

/** Lazy JS chunks: every JS output that is not in the eager set. */
export function chunkStats(
  metafile: LoadGraphMetafile,
  eagerFiles: ReadonlySet<string>
): ChunkStats {
  let chunks = 0;
  let smallChunks = 0;
  let smallChunkBytes = 0;
  let totalBytes = 0;
  for (const [path, output] of Object.entries(metafile.outputs)) {
    const key = outputKey(path);
    if (!key.endsWith('.js') || eagerFiles.has(key)) continue;
    chunks += 1;
    totalBytes += output.bytes;
    if (output.bytes < SMALL_CHUNK_BYTES) {
      smallChunks += 1;
      smallChunkBytes += output.bytes;
    }
  }
  return { chunks, smallChunks, smallChunkBytes, totalBytes };
}

export interface ModuleBytes {
  readonly module: string;
  readonly bytes: number;
}

/** Input modules in the eager outputs, largest first, by the bytes they add to those outputs. */
export function eagerModules(
  metafile: LoadGraphMetafile,
  eagerFiles: ReadonlySet<string>
): ModuleBytes[] {
  const bytesByModule = new Map<string, number>();
  for (const [path, output] of Object.entries(metafile.outputs)) {
    if (!eagerFiles.has(outputKey(path))) continue;
    for (const [module, { bytesInOutput }] of Object.entries(output.inputs)) {
      bytesByModule.set(module, (bytesByModule.get(module) ?? 0) + bytesInOutput);
    }
  }
  return [...bytesByModule]
    .map(([module, bytes]) => ({ module, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.module.localeCompare(b.module));
}

/**
 * The owner of a module path, for a by-package table: the npm package for
 * `node_modules` paths, `shared/<dir>` for the shared workspace and
 * `src/<dir>` for the frontend's own code.
 *
 * @example
 * moduleOwner('../../node_modules/.bun/react-dom@19.3.1/node_modules/react-dom/cjs/x.js'); // 'react-dom'
 * moduleOwner('../shared/src/i18n/en.ts'); // 'shared/i18n'
 * moduleOwner('src/features/chat/Chat.tsx'); // 'src/features/chat'
 */
export function moduleOwner(module: string): string {
  const marker = 'node_modules/';
  const nodeModules = module.lastIndexOf(marker);
  if (nodeModules !== -1) {
    const parts = module.slice(nodeModules + marker.length).split('/');
    return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : (parts[0] ?? module);
  }
  const shared = /^(?:\.\.\/)+shared\/src\/([^/]+)/.exec(module);
  if (shared) return `shared/${shared[1]}`;
  const own = /^src\/([^/]+)(?:\/([^/]+)\/)?/.exec(module);
  if (own) return own[2] && own[1] === 'features' ? `src/features/${own[2]}` : `src/${own[1]}`;
  return module;
}

/** Sums module bytes per owner, largest first. */
export function bytesByOwner(modules: readonly ModuleBytes[]): ModuleBytes[] {
  const owners = new Map<string, number>();
  for (const { module, bytes } of modules) {
    const owner = moduleOwner(module);
    owners.set(owner, (owners.get(owner) ?? 0) + bytes);
  }
  return [...owners]
    .map(([module, bytes]) => ({ module, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.module.localeCompare(b.module));
}

/**
 * One feature's first use: an ordered list of dynamic-import edges. Each step
 * names the module that calls `import()` and the module it loads, both as they
 * appear in the metafile's `inputs`. `to` entries load in parallel; `to` may be
 * a suffix, so a grammar matches whatever version of `@shikijs/langs` is installed.
 */
export interface LoadScenario {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly { readonly from: string; readonly to: readonly string[] }[];
}

const shikiGrammar = (name: string): string => `@shikijs/langs/dist/${name}.mjs`;
const shikiTheme = (name: string): string => `@shikijs/themes/dist/${name}.mjs`;

/**
 * A first fenced block loads the renderer, the highlighter core, then its own
 * grammar and the active theme in parallel (the default dark theme here).
 */
function markdownCodeScenario(id: string, title: string, grammar: string): LoadScenario {
  return {
    id,
    title,
    steps: [
      {
        from: 'src/components/MarkdownContent.tsx',
        to: ['src/components/MarkdownContentRenderer.tsx'],
      },
      { from: 'src/components/MarkdownContentRenderer.tsx', to: ['src/lib/shiki.ts'] },
      { from: 'src/lib/shiki.ts', to: [shikiGrammar(grammar), shikiTheme('one-dark-pro')] },
    ],
  };
}

export const LOAD_SCENARIOS: readonly LoadScenario[] = [
  {
    id: 'terminal',
    title: 'Open a terminal',
    steps: [
      {
        from: 'src/features/terminal/LazyTerminalView.tsx',
        to: ['src/features/terminal/TerminalView.tsx'],
      },
    ],
  },
  markdownCodeScenario('markdown-code', 'First markdown code block (ts)', 'typescript'),
  markdownCodeScenario('markdown-code-bash', 'First markdown code block (bash)', 'bash'),
  {
    id: 'git-panel',
    title: 'Open the Git panel',
    steps: [
      {
        from: 'src/features/workspace/rail/panel-registry.ts',
        to: ['src/features/workspace/GitPanel.tsx'],
      },
    ],
  },
  {
    id: 'github-panel',
    title: 'Open the GitHub panel',
    steps: [
      {
        from: 'src/features/workspace/rail/panel-registry.ts',
        to: ['src/features/github/components/GithubPanel.tsx'],
      },
    ],
  },
];

export interface ScenarioStepResult {
  readonly from: string;
  /** Chunks this step fetches that nothing earlier had loaded, in fetch order. */
  readonly chunks: readonly string[];
  /** Rounds this step needs: 1, or 0 when everything it loads is already there. */
  readonly rounds: number;
  readonly rawBytes: number;
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly ScenarioStepResult[];
  readonly rounds: number;
  readonly requests: number;
  readonly rawBytes: number;
}

/** The output file that contains `input`; every output that does, since a module can be duplicated. */
function outputsContaining(metafile: LoadGraphMetafile, input: string): string[] {
  return Object.entries(metafile.outputs)
    .filter(([, output]) => input in output.inputs)
    .map(([path]) => outputKey(path));
}

function inputsMatching(metafile: LoadGraphMetafile, suffixOrPath: string): string[] {
  return Object.keys(metafile.inputs).filter(
    (input) => input === suffixOrPath || input.endsWith(`/${suffixOrPath}`)
  );
}

/**
 * Resolves one scenario against the metafile. Throws, naming the module, when a
 * module the scenario names is not in the build: a renamed file must update the
 * scenario instead of quietly reporting "no requests".
 */
export function resolveScenario(
  metafile: LoadGraphMetafile,
  eagerFiles: ReadonlySet<string>,
  scenario: LoadScenario
): ScenarioResult {
  const loaded = new Set(eagerFiles);
  const steps: ScenarioStepResult[] = [];

  for (const step of scenario.steps) {
    const [from] = inputsMatching(metafile, step.from);
    if (from === undefined) {
      throw new Error(
        `scenario "${scenario.id}": module ${step.from} is not in the metafile; expected an input path such as src/...`
      );
    }
    const callerOutput = outputsContaining(metafile, from)[0];
    const callerDir = callerOutput === undefined ? '' : posix.dirname(callerOutput);

    const fetched: string[] = [];
    let rounds = 0;
    for (const target of step.to) {
      const [to] = inputsMatching(metafile, target);
      if (to === undefined) {
        throw new Error(`scenario "${scenario.id}": module ${target} is not in the metafile`);
      }
      const edge = metafile.inputs[from]?.imports.find(
        (candidate) => candidate.kind === 'dynamic-import' && candidate.entryPoint === to
      );
      if (edge === undefined) {
        // No dynamic edge: the module is bundled into whatever chunk holds the
        // caller. That is a valid result (eager), unless it is not loaded either.
        const holders = outputsContaining(metafile, to);
        if (!holders.some((holder) => loaded.has(holder))) {
          throw new Error(
            `scenario "${scenario.id}": ${from} has no dynamic import of ${to}, and ${to} is in ${holders.join(', ')}, which nothing loaded`
          );
        }
        continue;
      }
      const depth = fetchStatic(metafile, posix.join(callerDir, edge.path), loaded, fetched);
      rounds = Math.max(rounds, depth);
    }
    for (const chunk of fetched) loaded.add(chunk);
    steps.push({
      from,
      chunks: fetched,
      rounds,
      rawBytes: fetched.reduce((sum, chunk) => sum + (outputBytes(metafile, chunk) ?? 0), 0),
    });
  }

  return {
    id: scenario.id,
    title: scenario.title,
    steps,
    rounds: steps.reduce((sum, step) => sum + step.rounds, 0),
    requests: steps.reduce((sum, step) => sum + step.chunks.length, 0),
    rawBytes: steps.reduce((sum, step) => sum + step.rawBytes, 0),
  };
}

function outputBytes(metafile: LoadGraphMetafile, key: string): number | undefined {
  return (metafile.outputs[key] ?? metafile.outputs[`./${key}`])?.bytes;
}

/**
 * Fetches `target` and every static import behind it that is not loaded yet,
 * appending each newly fetched chunk to `fetched`. Returns 1 when the call
 * fetched anything and 0 when `target` was already loaded.
 *
 * One round, whatever the static depth: Bun's browser build writes a chunk
 * dependency table into the entry and every `import()` preloads the target's
 * whole static closure in parallel with the target (`bun build --help` lists
 * `--no-module-preload` for turning that off; the frontend build does not). A
 * 75 B stub in front of a 429 KB chunk therefore costs one round trip, not two.
 * Measured in Chromium: the stub and the chunk behind it start in the same
 * millisecond, and the chunk is still requested when the stub is blocked.
 */
function fetchStatic(
  metafile: LoadGraphMetafile,
  target: string,
  loaded: ReadonlySet<string>,
  fetched: string[]
): number {
  const pending = [outputKey(target)];
  const seen = new Set<string>();
  let fetchedAny = false;
  for (let key = pending.shift(); key !== undefined; key = pending.shift()) {
    if (loaded.has(key) || seen.has(key)) continue;
    seen.add(key);
    const output = metafile.outputs[key] ?? metafile.outputs[`./${key}`];
    if (output === undefined) throw new Error(`metafile has no output ${key}`);
    if (!fetched.includes(key)) fetched.push(key);
    fetchedAny = true;
    for (const edge of output.imports) {
      if (edge.kind === 'import-statement') pending.push(outputKey(edge.path));
    }
  }
  return fetchedAny ? 1 : 0;
}

export interface LoadGraphReport {
  readonly eager: EagerPayload;
  readonly assets: readonly EagerAsset[];
  readonly chunks: ChunkStats;
  readonly modules: readonly ModuleBytes[];
  readonly owners: readonly ModuleBytes[];
  readonly scenarios: readonly ScenarioResult[];
  /** Scenarios that no longer match the build; only filled when errors are collected. */
  readonly scenarioProblems: readonly string[];
}

/**
 * `onScenarioError: 'collect'` turns a scenario that names a module the build
 * no longer has into a `scenarioProblems` entry instead of a throw. The budget
 * gate uses it: renaming a file must not fail the build over a report row.
 */
export async function buildLoadGraphReport(
  distDir: string,
  metafile: LoadGraphMetafile,
  scenarios: readonly LoadScenario[] = LOAD_SCENARIOS,
  onScenarioError: 'throw' | 'collect' = 'throw'
): Promise<LoadGraphReport> {
  const bundle = await measureBundle(distDir, { builder: 'bun', capturedAt: '' });
  const eager = await measureEagerPayload(distDir, bundle.files);
  const eagerFiles = new Set(eager.files.map((file) => file.path));
  const modules = eagerModules(metafile, eagerFiles);
  const resolved: ScenarioResult[] = [];
  const scenarioProblems: string[] = [];
  for (const scenario of scenarios) {
    try {
      resolved.push(resolveScenario(metafile, eagerFiles, scenario));
    } catch (error) {
      if (onScenarioError === 'throw') throw error;
      scenarioProblems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    eager,
    assets: await measureEagerAssets(distDir, [...eagerFiles]),
    chunks: chunkStats(metafile, eagerFiles),
    modules,
    owners: bytesByOwner(modules),
    scenarios: resolved,
    scenarioProblems,
  };
}

export function renderLoadGraphReport(report: LoadGraphReport, moduleRows: number): string {
  const lines = [
    '### First load',
    '',
    '| Eager file | Raw | Gzip | Brotli |',
    '| --- | ---: | ---: | ---: |',
    ...report.eager.files.map(
      (file) => `| ${file.path} | ${file.rawBytes} | ${file.gzipBytes} | ${file.brotliBytes} |`
    ),
    `| **Total (${report.eager.files.length} files)** | **${report.eager.rawBytes}** | **${report.eager.gzipBytes}** | **${report.eager.brotliBytes}** |`,
    '',
    report.assets.length === 0
      ? 'Eager files reference no image or font.'
      : `Images and fonts the eager files reference (served as is): ${report.assets
          .map((asset) => `${asset.path} ${asset.bytes} B`)
          .join(', ')}.`,
    '',
    `Lazy chunks: ${report.chunks.chunks} (${report.chunks.smallChunks} under ${SMALL_CHUNK_BYTES} B, ${report.chunks.smallChunkBytes} B together), ${formatBytes(report.chunks.totalBytes)} raw.`,
    '',
    `### Eager bytes by package (${report.owners.length} owners)`,
    '',
    '| Owner | Bytes in output |',
    '| --- | ---: |',
    ...report.owners.slice(0, moduleRows).map((row) => `| ${row.module} | ${row.bytes} |`),
    '',
    `### Largest eager modules (top ${moduleRows} of ${report.modules.length})`,
    '',
    '| Module | Bytes in output |',
    '| --- | ---: |',
    ...report.modules
      .slice(0, moduleRows)
      .map((row) => `| ${shortModule(row.module)} | ${row.bytes} |`),
    '',
    '### First use of a feature',
    '',
    '| Feature | Rounds | Requests | Raw bytes fetched | Chunks, in fetch order |',
    '| --- | ---: | ---: | ---: | --- |',
    ...report.scenarios.map(
      (scenario) =>
        `| ${scenario.title} | ${scenario.rounds} | ${scenario.requests} | ${scenario.rawBytes} | ${
          scenario.requests === 0
            ? 'none (already eager)'
            : scenario.steps.flatMap((step) => step.chunks).join(', ')
        } |`
    ),
    '',
    ...(report.scenarioProblems.length === 0
      ? []
      : [
          '### Scenario problems',
          '',
          `LOAD_SCENARIOS in scripts/ci/frontend-load-graph.ts no longer matches the build, so the rows above are incomplete. Update the scenario to the renamed module; the eager total and the budget are not affected.`,
          '',
          ...report.scenarioProblems.map((problem) => `- ${problem}`),
          '',
        ]),
  ];
  return lines.join('\n');
}

/** Drops the package-manager store prefix so a table row stays readable. */
function shortModule(module: string): string {
  return module.replace(/^(?:\.\.\/)+node_modules\/\.bun\//, '');
}

export interface BundleBudget {
  readonly eagerBrotliBytes: number;
}

/** Parses a budget file, rejecting anything but a positive integer limit. */
export function parseBundleBudget(source: string, path: string): BundleBudget {
  const parsed: unknown = JSON.parse(source);
  const limit =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { eagerBrotliBytes?: unknown }).eagerBrotliBytes
      : undefined;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `${path}: expected {"eagerBrotliBytes": <positive integer>}, received ${source.trim().slice(0, 80)}`
    );
  }
  return { eagerBrotliBytes: limit };
}

export interface BudgetContext {
  /** The budget file as the caller named it, so the message says where to raise it. */
  readonly budgetPath: string;
  /** `Bun.version_with_sha`: tells a bundler change apart from a source change. */
  readonly bunRevision: string;
}

/** The failure message when the eager payload is over budget, or `undefined` when it fits. */
export function budgetViolation(
  eager: EagerPayload,
  budget: BundleBudget,
  context: BudgetContext
): string | undefined {
  if (eager.brotliBytes <= budget.eagerBrotliBytes) return undefined;
  return [
    `eager payload is ${eager.brotliBytes} B Brotli over ${eager.files.length} files; the budget in ${context.budgetPath} is ${budget.eagerBrotliBytes} B (over by ${eager.brotliBytes - budget.eagerBrotliBytes} B), built with Bun ${context.bunRevision}.`,
    `If the growth is intended (a dependency bump, a feature that belongs in the first load), raise "eagerBrotliBytes" in ${context.budgetPath} in this PR.`,
    'Otherwise a static import may have pulled lazy code into the entry: run this script without --budget and read "Largest eager modules".',
  ].join('\n');
}

/** The pass line, with the numbers and Bun revision a drift investigation starts from. */
export function budgetSummary(
  eager: EagerPayload,
  budget: BundleBudget,
  context: BudgetContext
): string {
  return `eager ${eager.brotliBytes} B Brotli within the ${budget.eagerBrotliBytes} B budget in ${context.budgetPath} (${budget.eagerBrotliBytes - eager.brotliBytes} B spare), built with Bun ${context.bunRevision}`;
}

const VALUE_FLAGS = ['--dist', '--metafile', '--modules', '--budget'] as const;
const USAGE =
  'Usage: bun ./scripts/ci/frontend-load-graph.ts [--dist <dir>] [--metafile <file>] [--modules <n>] [--json] [--budget <file>]';

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function assertKnownFlags(argv: readonly string[]): void {
  const valueFlags: readonly string[] = VALUE_FLAGS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (valueFlags.includes(arg)) {
      index += 1;
      continue;
    }
    if (arg === '--json') continue;
    throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  assertKnownFlags(argv);
  const distDir = flagValue(argv, '--dist') ?? DEFAULT_DIST_DIR;
  const metafilePath =
    flagValue(argv, '--metafile') ?? join(dirname(distDir), 'dist-metafile.json');
  const metafileFile = Bun.file(metafilePath);
  if (!(await metafileFile.exists())) {
    throw new Error(`no metafile at ${metafilePath}; build the frontend first`);
  }
  const moduleRows = Number(flagValue(argv, '--modules') ?? DEFAULT_MODULE_ROWS);
  if (!Number.isInteger(moduleRows) || moduleRows < 1) {
    throw new Error(`--modules expects a positive integer, received ${moduleRows}`);
  }

  const budgetPath = flagValue(argv, '--budget');
  const budget = budgetPath
    ? parseBundleBudget(await Bun.file(budgetPath).text(), budgetPath)
    : undefined;

  const report = await buildLoadGraphReport(
    distDir,
    (await metafileFile.json()) as LoadGraphMetafile,
    LOAD_SCENARIOS,
    budget ? 'collect' : 'throw'
  );
  process.stdout.write(
    argv.includes('--json')
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderLoadGraphReport(report, moduleRows)
  );

  if (budget && budgetPath) {
    const context = { budgetPath, bunRevision: Bun.version_with_sha };
    const violation = budgetViolation(report.eager, budget, context);
    if (violation) {
      process.stderr.write(`frontend-load-graph: ${violation}\n`);
      process.exit(1);
    }
    process.stderr.write(`frontend-load-graph: ${budgetSummary(report.eager, budget, context)}\n`);
  }
}
