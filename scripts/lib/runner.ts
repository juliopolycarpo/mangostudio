import { type WorkspaceName, ALL_WORKSPACE_NAMES, WORKSPACES, ROOT_DIR } from './config';

const SCRIPT_START = performance.now();

// ── ANSI colors ──

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

export function log(msg: string): void {
  console.log(msg);
}
export function info(msg: string): void {
  console.log(`${CYAN}${msg}${RESET}`);
}
export function success(msg: string): void {
  console.log(`${GREEN}${BOLD}${msg}${RESET}`);
}
export function warn(msg: string): void {
  console.log(`${YELLOW}${msg}${RESET}`);
}
export function error(msg: string): void {
  console.error(`${RED}${BOLD}${msg}${RESET}`);
}
export function dim(msg: string): void {
  console.log(`${DIM}${msg}${RESET}`);
}
export function header(msg: string): void {
  console.log(`\n${BOLD}${msg}${RESET}`);
}

// ── Arg parsing ──

export interface ParsedArgs {
  workspaces: WorkspaceName[];
  includeRoot: boolean;
  flags: Record<string, boolean>;
  values: Record<string, string>;
  positional: string[];
  usedDefaultSelection: boolean;
}

export interface ParseArgsOptions {
  booleanFlags?: string[];
  valueFlags?: string[];
}

export function parseArgs(options: ParseArgsOptions = {}): ParsedArgs {
  const args = process.argv.slice(2);
  const booleanFlags = new Set(['--help', ...(options.booleanFlags ?? [])]);
  const valueFlags = new Set(options.valueFlags ?? []);
  const workspaces: WorkspaceName[] = [];
  let includeRoot = false;
  let allExplicit = false;
  const flags: Record<string, boolean> = {};
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--frontend') workspaces.push('frontend');
    else if (arg === '--api') workspaces.push('api');
    else if (arg === '--shared') workspaces.push('shared');
    else if (arg === '--root') includeRoot = true;
    else if (arg === '--all') allExplicit = true;
    else if (booleanFlags.has(arg)) flags[arg] = true;
    else if (arg.startsWith('--')) {
      const [flagName, inlineValue] = arg.split('=', 2);
      if (valueFlags.has(flagName)) {
        const nextValue = inlineValue ?? args[index + 1];
        if (!nextValue || (inlineValue === undefined && nextValue.startsWith('--'))) {
          positional.push(arg);
          continue;
        }

        values[flagName] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
      } else {
        positional.push(arg);
      }
    } else positional.push(arg);
  }

  // Default: --all (all workspaces + root)
  if (workspaces.length === 0 && !includeRoot && !allExplicit) {
    return {
      workspaces: [...ALL_WORKSPACE_NAMES],
      includeRoot: true,
      flags,
      values,
      positional,
      usedDefaultSelection: true,
    };
  }
  if (allExplicit) {
    return {
      workspaces: [...ALL_WORKSPACE_NAMES],
      includeRoot: true,
      flags,
      values,
      positional,
      usedDefaultSelection: false,
    };
  }

  return { workspaces, includeRoot, flags, values, positional, usedDefaultSelection: false };
}

export function fatal(msg: string): never {
  error(msg);
  process.exit(1);
}

export function assertNoUnexpectedArguments(positional: string[]): void {
  if (positional.length > 0) {
    fatal(`Unknown argument(s): ${positional.join(' ')}`);
  }
}

// ── Process execution ──

export interface RunResult {
  label: string;
  exitCode: number;
  duration: number;
}

export async function runCommand(
  label: string,
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<RunResult> {
  const start = performance.now();
  dim(`  $ ${cmd.join(' ')}`);

  const proc = Bun.spawn({
    cmd,
    cwd: opts?.cwd ?? ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, ...opts?.env },
  });

  const exitCode = await proc.exited;
  const duration = Math.round(performance.now() - start);

  return { label, exitCode, duration };
}

export async function runWorkspaceScript(
  workspace: WorkspaceName,
  script: string,
  opts?: { ifPresent?: boolean }
): Promise<RunResult> {
  const ws = WORKSPACES[workspace];
  const cmd = ['bun', 'run'];
  if (opts?.ifPresent) cmd.push('--if-present');
  cmd.push('--filter', ws.packageName, script);
  return runCommand(`${workspace}:${script}`, cmd);
}

// ── Orchestration ──

export async function runParallel(tasks: Array<() => Promise<RunResult>>): Promise<RunResult[]> {
  return Promise.all(tasks.map((t) => t()));
}

// ── Summary & exit ──

export function printSummary(results: RunResult[]): void {
  header('Summary');
  for (const r of results) {
    const icon = r.exitCode === 0 ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`;
    const time = `${DIM}${r.duration}ms${RESET}`;
    console.log(`  ${icon}  ${r.label}  ${time}`);
  }
  const total = Math.round(performance.now() - SCRIPT_START);
  console.log(`\n  ${DIM}Total: ${total}ms${RESET}`);
}

export function exitWithResults(results: RunResult[]): never {
  printSummary(results);
  const failed = results.filter((r) => r.exitCode !== 0);
  if (failed.length > 0) {
    error(`\n${failed.length} task(s) failed.`);
    process.exit(1);
  }
  success('\nAll tasks passed.');
  process.exit(0);
}
