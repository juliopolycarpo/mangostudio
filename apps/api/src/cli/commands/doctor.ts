/**
 * `doctor` command: run environment and configuration diagnostics and print a
 * plain-text checklist. Exits non-zero if any check fails. The checks
 * themselves live in the machine module, which the API serves from too.
 */

import {
  collectDoctorChecks,
  type DoctorCollectDeps,
} from '../../modules/machine/application/doctor-service';
import type { DoctorArgs } from '../args';
import { DEFAULT_DOCTOR_ARGS } from '../args';
import type { CheckResult, CheckStatus } from '../doctor-checks';
import { writeLine } from '../output';

export interface DoctorDeps extends DoctorCollectDeps {
  log: (msg: string) => void;
  exit: (code: number) => void;
}

/** Run diagnostics and print a checklist; exit 1 on any failure. // Usage: await runDoctor() */
export async function runDoctor(
  options: DoctorArgs = DEFAULT_DOCTOR_ARGS,
  deps: Partial<DoctorDeps> = {}
): Promise<void> {
  const { log = writeLine, exit = (code: number) => process.exit(code), ...collect } = deps;
  // `collectDoctorChecks`'s own default is false — right for the API route and
  // every test that does not care — so only the actual CLI command asks a real
  // terminal, and only when the caller left it unset.
  const results = await collectDoctorChecks(options, {
    isTty: () => Boolean(process.stdout.isTTY),
    ...collect,
  });
  render(results, options, { log, exit });
}

function render(
  results: CheckResult[],
  options: DoctorArgs,
  d: Pick<Required<DoctorDeps>, 'log' | 'exit'>
): void {
  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;

  if (options.json) {
    d.log(
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
    if (failures > 0) {
      d.exit(1);
    }
    return;
  }

  d.log('MangoStudio doctor\n');
  for (const result of results) {
    d.log(`${badge(result.status)} ${result.label.padEnd(18)} ${result.detail}`);
  }

  d.log(`\n${warnings} warning(s), ${failures} failure(s).`);

  if (failures > 0) {
    d.exit(1);
  }
}

function badge(status: CheckStatus): string {
  if (status === 'ok') {
    return '[ok]  ';
  }
  return status === 'warn' ? '[warn]' : '[fail]';
}
