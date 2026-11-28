#!/usr/bin/env bun
// Times the first start of the tools the Windows layout tests spawn, then reads the trees they
// load from, so a cold start is paid and named here instead of inside a 15 s test (#2661).
// Never fails the job: a missing tool or a slow disk is a log line, not a verdict.
// Reasoning and the numbers behind it: scripts/lib/windows-cold-start.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  findGitRoot,
  formatStartTiming,
  formatTreeRead,
  readTree,
  type RunCommand,
  type StartTarget,
  timeStarts,
} from '../lib/windows-cold-start';

const PER_COMMAND_TIMEOUT_MS = 60_000;
const PREFIX = '[windows-cold-start]';

const run: RunCommand = (command, env) => {
  try {
    const result = Bun.spawnSync([...command], {
      env: { ...process.env, ...env },
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: PER_COMMAND_TIMEOUT_MS,
    });
    return result.exitCode;
  } catch {
    // A tool that is not installed reports as exit null rather than aborting the step.
    return null;
  }
};

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const git = Bun.which('git');
const gitRoot = git ? findGitRoot(git, existsSync) : undefined;
if (!gitRoot) console.log(`${PREFIX} no Git install root above ${git ?? 'git (not on PATH)'}`);
const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');

const targets: StartTarget[] = [
  { label: 'git', command: ['git', '--version'] },
  { label: 'system-tar', command: [join(systemRoot, 'System32', 'tar.exe'), '--version'] },
  {
    label: 'windows-powershell',
    command: [
      join(windowsPowerShell, 'powershell.exe'),
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'exit',
    ],
  },
];
if (Bun.which('gh')) targets.push({ label: 'gh', command: ['gh', '--version'] });
if (gitRoot) {
  const bash = join(gitRoot, 'bin', 'bash.exe');
  targets.push(
    { label: 'git-bash', command: [bash, '-c', 'true'] },
    {
      label: 'git-gnu-tools',
      command: [
        bash,
        '-c',
        'tar --version >/dev/null && gzip --version >/dev/null && sha256sum --version >/dev/null && mktemp --version >/dev/null',
      ],
    },
    {
      // install-sh-layout's first case builds a symlink farm the way the tests do.
      label: 'git-native-symlink',
      env: { MSYS: 'winsymlinks:nativestrict' },
      command: [
        bash,
        '-c',
        'd=$(mktemp -d) && : > "$d/a" && ln -s a "$d/b" && test -L "$d/b"; status=$?; rm -rf "$d"; exit $status',
      ],
    }
  );
}

console.log(
  `${PREFIX} image ${process.env.ImageVersion ?? 'unknown'}, ${process.env.NUMBER_OF_PROCESSORS ?? '?'} cpus`
);
for (const target of targets)
  console.log(formatStartTiming(timeStarts(target, run, performance.now)));

// Defender: one cold PowerShell, itself timed above as windows-powershell. A scan would show as
// RealTimeProtectionEnabled True; the 2026-11 probe found it False on windows-latest.
const defender = Bun.spawnSync(
  [
    join(windowsPowerShell, 'powershell.exe'),
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'try { $s = Get-MpComputerStatus; $p = Get-MpPreference; "realtime=$($s.RealTimeProtectionEnabled) antivirus=$($s.AntivirusEnabled) exclusions=$(@($p.ExclusionPath).Count)" } catch { "unavailable: $($_.Exception.Message)" }',
  ],
  { stdout: 'pipe', stderr: 'ignore', timeout: PER_COMMAND_TIMEOUT_MS }
);
console.log(`${PREFIX} defender ${defender.stdout.toString().trim() || 'no output'}`);

const limits = { maxFileBytes: 64_000_000, budgetMs: 45_000 };
const trees: { label: string; root: string }[] = [
  { label: 'windows-powershell', root: windowsPowerShell },
  ...(gitRoot
    ? [
        { label: 'git-usr-bin', root: join(gitRoot, 'usr', 'bin') },
        // The native tool directory is named after the build's environment; only one exists.
        ...['mingw64', 'ucrt64', 'clangarm64']
          .map((environment) => ({
            label: `git-${environment}-bin`,
            root: join(gitRoot, environment, 'bin'),
          }))
          .filter(({ root }) => existsSync(root)),
      ]
    : []),
];
for (const tree of trees) {
  console.log(formatTreeRead(readTree(tree.label, tree.root, limits, performance.now)));
}
