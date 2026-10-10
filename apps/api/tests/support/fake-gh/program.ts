/**
 * A stand-in for the GitHub CLI that a test compiles into a real executable.
 *
 * The runtime starts `gh` by name, and on Windows it only resolves `gh` and
 * `gh.exe` (`which_in` for the manifest probe, `CreateProcessW` for the spawn):
 * a `#!/bin/sh` script is not executable there and a `gh.cmd` is never found.
 * So the fake has to be a PE file. `install.ts` compiles this module with
 * `bun build --compile`; the executable answers from the scenario file that
 * sits next to it, which is how one build serves many scenarios.
 *
 * Imported by a test, the module only exports {@link fakeGhReply}. Run as the
 * compiled entry point, it reads its scenario and behaves like `gh`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What the fake `gh` should do, in the shape a test writes it. */
export interface FakeGhScenario {
  readonly authenticated?: boolean;
  readonly repoStdout?: string;
  readonly repoStderr?: string;
  readonly prStdout?: string;
  readonly prStderr?: string;
  /** Fail every call with 127, the way the manifest probe sees a `gh` it cannot run. */
  readonly unusable?: boolean;
}

/** One finished `gh` invocation. */
export interface FakeGhReply {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** The file, beside the executable, that carries the scenario. */
export const FAKE_GH_SCENARIO_FILE = 'scenario.json';

/** Exit status for an executable that cannot find its scenario, distinct from any `gh` status. */
export const FAKE_GH_MISSING_SCENARIO_EXIT = 70;

export const DEFAULT_REPO_OUTPUT = JSON.stringify({
  nameWithOwner: 'mango/mangostudio',
  defaultBranchRef: { name: 'main' },
  url: 'https://github.example/mango/mangostudio',
});

export const DEFAULT_PR_OUTPUT = JSON.stringify({
  number: 42,
  title: 'Expose GitHub context',
  state: 'OPEN',
  isDraft: true,
  url: 'https://github.example/mango/mangostudio/pull/42',
  headRefName: 'feat/github-context',
  baseRefName: 'main',
});

const VERSION_OUTPUT =
  'gh version 2.97.0 (2026-07-31)\nhttps://github.com/cli/cli/releases/tag/v2.97.0\n';
const AUTHENTICATED_OUTPUT = '{"hosts":{"github.example":[{"active":true,"state":"success"}]}}\n';
const ANONYMOUS_OUTPUT = '{"hosts":{}}\n';

const VERSION_ARGS = '--version';
const AUTH_ARGS = 'auth status --json hosts';
const REPO_ARGS = 'repo view --json nameWithOwner,defaultBranchRef,url';
const PR_ARGS = 'pr view --json number,title,state,isDraft,url,headRefName,baseRefName';

/**
 * What the fake `gh` prints and exits with for `args` under `scenario`.
 *
 * Only the four commands the GitHub context route issues are answered; any
 * other argv is a test that drifted from the route, and exits 64 naming it.
 *
 * @example
 * fakeGhReply(['--version'], {}).exitCode; // 0
 * fakeGhReply(['pr', 'view', '--json', 'number'], {}).exitCode; // 64
 */
export function fakeGhReply(args: readonly string[], scenario: FakeGhScenario): FakeGhReply {
  if (scenario.unusable) return { stdout: '', stderr: '', exitCode: 127 };
  const command = args.join(' ');
  if (command === VERSION_ARGS) return { stdout: VERSION_OUTPUT, stderr: '', exitCode: 0 };
  if (command === AUTH_ARGS) return authReply(scenario);
  if (command === REPO_ARGS) {
    return commandReply(scenario.repoStdout ?? DEFAULT_REPO_OUTPUT, scenario.repoStderr);
  }
  if (command === PR_ARGS) {
    return commandReply(scenario.prStdout ?? DEFAULT_PR_OUTPUT, scenario.prStderr);
  }
  return {
    stdout: '',
    stderr: `unexpected gh command: ${command} | expected one of: ${[VERSION_ARGS, AUTH_ARGS, REPO_ARGS, PR_ARGS].join(' ; ')}\n`,
    exitCode: 64,
  };
}

function authReply(scenario: FakeGhScenario): FakeGhReply {
  if (scenario.authenticated === false) {
    return { stdout: ANONYMOUS_OUTPUT, stderr: 'not logged in\n', exitCode: 0 };
  }
  return { stdout: AUTHENTICATED_OUTPUT, stderr: '', exitCode: 0 };
}

function commandReply(stdout: string, stderr: string | undefined): FakeGhReply {
  if (stderr !== undefined) return { stdout: '', stderr: `${stderr}\n`, exitCode: 1 };
  return { stdout: `${stdout}\n`, stderr: '', exitCode: 0 };
}

function runAsExecutable(): void {
  const scenarioPath = join(dirname(process.execPath), FAKE_GH_SCENARIO_FILE);
  let scenario: FakeGhScenario;
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as FakeGhScenario;
  } catch (error) {
    process.stderr.write(
      `fake gh: scenario unreadable at ${scenarioPath} | expected: a JSON file next to the executable | received: ${String(error)}\n`
    );
    process.exitCode = FAKE_GH_MISSING_SCENARIO_EXIT;
    return;
  }
  // argv is [executable, entry module, ...the arguments gh was given].
  const reply = fakeGhReply(process.argv.slice(2), scenario);
  process.stdout.write(reply.stdout);
  process.stderr.write(reply.stderr);
  process.exitCode = reply.exitCode;
}

if (import.meta.main) runAsExecutable();
