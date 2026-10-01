/**
 * `doctor` command: run environment and configuration diagnostics and print a
 * plain-text checklist. Exits non-zero if any check fails. The checks
 * themselves live in the machine module, which the API serves from too.
 */

import {
  collectDoctorChecks,
  type DoctorCollectDeps,
} from '../../modules/machine/application/doctor-service';
import { releaseRuntimeConnections } from '../../services/runtime-client/runtime-connection-release';
import type { DoctorArgs } from '../args';
import { DEFAULT_DOCTOR_ARGS } from '../args';
import type { CheckResult, CheckStatus } from '../doctor-checks';
import { writeLine } from '../output';

export interface DoctorDeps extends DoctorCollectDeps {
  log: (msg: string) => void;
  exit: (code: number) => void;
  /** Closes the runtime connections the checks opened and resolves once their children are gone. */
  releaseRuntimes: () => Promise<void>;
}

/**
 * Run diagnostics and print a checklist; exit 1 on any failure.
 *
 * The environments checks open the Local runtime, a spawned child process.
 * Doctor releases it, and waits for the child to exit, before it calls `exit`
 * or resolves: `process.exit` would otherwise leave the child running and
 * re-parented to PID 1, which in a container without an init never reaps it.
 *
 * // Usage: await runDoctor()
 */
export async function runDoctor(
  options: DoctorArgs = DEFAULT_DOCTOR_ARGS,
  deps: Partial<DoctorDeps> = {}
): Promise<void> {
  const {
    log = writeLine,
    exit = (code: number) => process.exit(code),
    releaseRuntimes = releaseRuntimeConnections,
    ...collect
  } = deps;
  // `collectDoctorChecks`'s own default is false — right for the API route and
  // every test that does not care — so only the actual CLI command asks a real
  // terminal, and only when the caller left it unset.
  const results = await collectDoctorChecks(options, {
    isTty: () => Boolean(process.stdout.isTTY),
    ...collect,
  });
  const failures = render(results, options, log);
  // After the report is out, so a release that fails never hides it; before
  // `exit`, which ends the process without waiting for anything.
  await releaseRuntimes();
  if (failures > 0) exit(1);
}

/** Prints the report and returns how many checks failed. */
function render(results: CheckResult[], options: DoctorArgs, log: DoctorDeps['log']): number {
  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;

  if (options.json) {
    log(
      JSON.stringify(
        {
          checks: results,
          warnings,
          failures,
        },
        null,
        2
      )
    );
    return failures;
  }

  log('MangoStudio doctor\n');
  for (const result of results) {
    log(`${badge(result.status)} ${result.label.padEnd(18)} ${result.detail}`);
  }

  log(`\n${warnings} warning(s), ${failures} failure(s).`);
  return failures;
}

function badge(status: CheckStatus): string {
  if (status === 'ok') {
    return '[ok]  ';
  }
  return status === 'warn' ? '[warn]' : '[fail]';
}
