import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readText } from './read-text';

const CACHE_SCOPED_MANIFEST = '.github/actions/cache-scoped/action.yml';

interface CompositeStep {
  readonly id?: string;
  readonly run?: string;
}

interface CompositeManifest {
  readonly runs: { readonly steps: readonly CompositeStep[] };
}

/** What one composite step left behind after it ran under bash. */
export interface StepResult {
  readonly exitCode: number;
  /** Where `::error::` workflow commands land. */
  readonly stdout: string;
  readonly stderr: string;
  /** `key=value` and `key<<EOF` entries the step appended to `$GITHUB_OUTPUT`. */
  readonly outputs: Readonly<Record<string, string>>;
  /** What the step appended to `$GITHUB_STEP_SUMMARY`. */
  readonly summary: string;
}

/**
 * The `run:` script of one cache-scoped step, by step id.
 *
 * Throws with the ids that do exist, so a test for a step that was never
 * written fails on the missing step and not on an incidental parse error.
 *
 * // Usage: compositeStepScript('keys').includes('primary_key=');
 */
function compositeStepScript(stepId: string): string {
  const manifest = Bun.YAML.parse(readText(CACHE_SCOPED_MANIFEST)) as CompositeManifest;
  const step = manifest.runs.steps.find((candidate) => candidate.id === stepId);
  if (step?.run === undefined) {
    const ids = manifest.runs.steps.map((candidate) => candidate.id ?? '(no id)');
    throw new Error(
      `expected ${CACHE_SCOPED_MANIFEST} step with id '${stepId}' and a run script | received step ids: ${ids.join(', ')}`
    );
  }
  return step.run;
}

/** Parse the `$GITHUB_OUTPUT` grammar: `key=value` lines and `key<<DELIM` blocks. */
function parseGithubOutput(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = /^([\w-]+)<<(\S+)$/.exec(lines[index]);
    if (heredoc) {
      const [, key, delimiter] = heredoc;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        body.push(lines[index]);
        index += 1;
      }
      outputs[key] = body.join('\n');
      continue;
    }
    const pair = /^([\w-]+)=(.*)$/.exec(lines[index]);
    if (pair) outputs[pair[1]] = pair[2];
  }
  return outputs;
}

/**
 * Run one cache-scoped step's script under bash with exactly the environment
 * given, in a throwaway working directory.
 *
 * The script is the one the composite ships, not a copy, so a test that passes
 * here passed against the text GitHub will execute. Only expressions are left
 * to the caller: the `env:` values GitHub would have interpolated are passed
 * in `env` directly.
 *
 * // Usage: await runCompositeStep('keys', { FAMILY: 'turbo', MODE: 'restore' }, cwd);
 */
export async function runCompositeStep(
  stepId: string,
  env: Readonly<Record<string, string>>,
  cwd: string
): Promise<StepResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'cache-scoped-step-'));
  try {
    const outputFile = join(scratch, 'github-output');
    const summaryFile = join(scratch, 'step-summary');
    const scriptFile = join(scratch, 'step.sh');
    writeFileSync(outputFile, '');
    writeFileSync(summaryFile, '');
    writeFileSync(scriptFile, compositeStepScript(stepId));

    const proc = Bun.spawn({
      cmd: ['bash', '--noprofile', '--norc', scriptFile],
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: scratch,
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: scratch,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      exitCode,
      stdout,
      stderr,
      outputs: parseGithubOutput(readFileSync(outputFile, 'utf8')),
      summary: readFileSync(summaryFile, 'utf8'),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

interface WriteScopeContext {
  readonly event_name: string;
  readonly ref: string;
  readonly run_id: string;
  readonly event: { readonly pull_request?: { readonly number: number } };
}

type ScopeValue = string | boolean | undefined;

/** One operand of the expression: a comparison, a `format` call, or a literal. */
function evaluateScopeTerm(term: string, github: WriteScopeContext): ScopeValue {
  const lookup = (path: string): ScopeValue => {
    let value: unknown = { github };
    for (const segment of path.split('.')) {
      value = (value as Record<string, unknown> | undefined)?.[segment];
    }
    return value === undefined ? undefined : String(value);
  };

  const comparison = /^([\w.]+) == '([^']*)'$/.exec(term);
  if (comparison) return lookup(comparison[1]) === comparison[2];

  const format = /^format\('([^']*)', ([\w.]+)\)$/.exec(term);
  if (format) return format[1].replace('{0}', String(lookup(format[2])));

  const literal = /^'([^']*)'$/.exec(term);
  if (literal) return literal[1];

  throw new Error(
    `expected a WRITE_SCOPE term that is a comparison, a format() call or a string literal | received: ${term}`
  );
}

/**
 * Evaluate the composite's `WRITE_SCOPE` expression for one workflow context.
 *
 * Reads the shipped text and applies GitHub's operator semantics (`&&` and `||`
 * return an operand, `||` binds looser than `&&`) to the three term shapes it
 * uses, so a test shows which scope a given event writes instead of asserting
 * that some substrings appear. A term it cannot read throws with the term, so
 * a rewritten expression fails here and is not silently skipped.
 *
 * // Usage: evaluateWriteScope({ event_name: 'pull_request', ref: 'refs/pull/7/merge', run_id: '1', event: { pull_request: { number: 7 } } }) // 'pr-7'
 */
export function evaluateWriteScope(github: WriteScopeContext): string {
  const manifest = Bun.YAML.parse(readText(CACHE_SCOPED_MANIFEST)) as {
    readonly runs: {
      readonly steps: readonly { readonly id?: string; readonly env?: Record<string, string> }[];
    };
  };
  const expression = manifest.runs.steps.find((step) => step.id === 'keys')?.env?.WRITE_SCOPE;
  const inner = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expression ?? '')?.[1];
  if (inner === undefined) {
    throw new Error(
      `expected ${CACHE_SCOPED_MANIFEST} keys step env WRITE_SCOPE as one \${{ }} expression | received: ${expression}`
    );
  }

  const truthy = (value: ScopeValue) => value !== undefined && value !== false && value !== '';
  const evaluateAnd = (chain: string): ScopeValue => {
    let value: ScopeValue = true;
    for (const term of chain.split(' && ')) {
      value = evaluateScopeTerm(term.trim(), github);
      if (!truthy(value)) return value;
    }
    return value;
  };

  let result: ScopeValue = '';
  for (const chain of inner.split(' || ')) {
    result = evaluateAnd(chain);
    if (truthy(result)) break;
  }
  return String(result);
}
