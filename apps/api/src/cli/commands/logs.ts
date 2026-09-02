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
  latestHubLogFile,
  realFollowDeps,
  tailLines,
} from '../log-tail';
import { writeLine } from '../output';

export interface LogsDeps {
  readState: typeof readState;
  latestLogFile: () => Promise<string | null>;
  readFile: (path: string) => Promise<string | null>;
  log: (msg: string) => void;
  write: (chunk: string) => void;
  follow: FollowDeps;
}

/** Print the last lines of the hub log, optionally following it. // Usage: await runLogs({ follow: false, lines: 100 }) */
export async function runLogs(args: LogsArgs, deps: Partial<LogsDeps> = {}): Promise<void> {
  const d = resolveDeps(deps);
  const state = await d.readState();
  const file = state?.logFile || (await d.latestLogFile());
  if (!file) {
    throw new CliError(
      'No log file to show. A foreground "mangostudio serve" writes to its terminal; "serve -d" and the service write under ~/.mango/logs.'
    );
  }

  const content = await d.readFile(file);
  if (content === null) {
    throw new CliError(`Log file not found: ${file}`);
  }

  const { lines } = tailLines(content, args.lines);
  if (lines.length > 0) d.log(lines.join('\n'));
  if (!args.follow) return;

  await followFile(file, Buffer.byteLength(content), d.write, d.follow);
}

function resolveDeps(deps: Partial<LogsDeps>): Required<LogsDeps> {
  return {
    readState: deps.readState ?? readState,
    latestLogFile: deps.latestLogFile ?? (() => latestHubLogFile(getLogsDir())),
    readFile: deps.readFile ?? readFileOrNull,
    log: deps.log ?? writeLine,
    write: deps.write ?? ((chunk) => process.stdout.write(chunk)),
    follow: deps.follow ?? realFollowDeps(),
  };
}

async function readFileOrNull(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : null;
}
