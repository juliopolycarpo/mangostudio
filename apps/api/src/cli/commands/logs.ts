/**
 * `logs` command: print the tail of the hub's log file, following it on
 * request. The file is whichever the state file names; when nothing is
 * recorded, the newest log in ~/.mango/logs stands in, so the last crash is
 * still readable after the state file is gone.
 */

import { getLogsDir } from '../../lib/mango-paths';
import { readState } from '../../lib/server-state';
import type { LogsArgs } from '../args';
import { CliError } from '../errors';
import {
  type FollowDeps,
  followFile,
  type LogTail,
  latestHubLogFile,
  readLogTail,
  realFollowDeps,
  resolveHubLogFile,
} from '../log-tail';
import { writeLine } from '../output';

export interface LogsDeps {
  readState: typeof readState;
  latestLogFile: () => Promise<string | null>;
  readTail: (path: string, count: number) => Promise<LogTail | null>;
  log: (msg: string) => void;
  write: (chunk: string) => void;
  follow: FollowDeps;
}

/** Print the last lines of the hub log, optionally following it. // Usage: await runLogs({ follow: false, lines: 100 }) */
export async function runLogs(args: LogsArgs, deps: Partial<LogsDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const file = await resolveHubLogFile(d.readState, d.latestLogFile);
  if (!file) {
    throw new CliError(
      'No log file to show. A foreground "mangostudio serve" writes to its terminal; "serve -d" and the service write under ~/.mango/logs.'
    );
  }

  const tail = await d.readTail(file, args.lines);
  if (tail === null) {
    throw new CliError(`Log file not found: ${file}`);
  }

  if (tail.lines.length > 0) d.log(tail.lines.join('\n'));
  if (!args.follow) return;

  await followFile(file, tail.offset, d.write, d.follow);
}

function resolveDeps(deps: Partial<LogsDeps>): Required<LogsDeps> {
  return {
    readState: deps.readState ?? readState,
    latestLogFile: deps.latestLogFile ?? (() => latestHubLogFile(getLogsDir())),
    readTail: deps.readTail ?? readLogTail,
    log: deps.log ?? writeLine,
    write: deps.write ?? ((chunk) => process.stdout.write(chunk)),
    follow: deps.follow ?? realFollowDeps(),
  };
}
