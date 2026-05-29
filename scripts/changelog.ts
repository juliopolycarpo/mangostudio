import { type CliffResult, parseChangelogArgs, runChangelog } from './lib/changelog';
import { ROOT_DIR } from './lib/config';

function printHelp(): never {
  console.log(`Usage: bun run changelog <mode>

Project wrapper around git-cliff (see cliff.toml). Modes:
  --init                 Regenerate CHANGELOG.md from full history (tagged v0.1.0)
  --preview [--base ref] Print this branch's changelog entries (default base: origin/main)
  --release <version>    Regenerate CHANGELOG.md including <version>
  --help                 Show this help message`);
  process.exit(0);
}

// Real git-cliff invocation. Captures stdout (preview prints it) and streams
// git-cliff's own diagnostics to stderr.
const runCliff = (args: readonly string[]): CliffResult => {
  const proc = Bun.spawnSync(['bunx', 'git-cliff', ...args], { cwd: ROOT_DIR });
  process.stderr.write(proc.stderr.toString());
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? 0 };
};

const mode = parseChangelogArgs(process.argv.slice(2));
if (!mode) {
  printHelp();
}

const { output, exitCode } = runChangelog(mode, runCliff);
if (mode.kind === 'preview') {
  process.stdout.write(output);
}
process.exit(exitCode);
