import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { extractStepBlocksUsing } from './workflow-blocks';
import { compositeActionFiles, parseWithInputs, workflowFiles } from './workflow-files';

const INSTALL_ACTION = 'taiki-e/install-action';

// `<name>@<major>.<minor>.<patch>` and nothing else: no `latest`, no range, no
// prerelease. install-action resolves a bare name to the newest release, so a
// tool release could change a gate's verdict on a commit nobody touched.
const EXACT_TOOL_PIN = /^(?<name>[\w.-]+)@(?<version>\d+\.\d+\.\d+)$/;

/** One tool a `taiki-e/install-action` step asks for. */
export interface InstallActionTool {
  readonly file: string;
  /** The entry as written: `cargo-deny@0.22.0`, a bare `cargo-deny`, or '' when `tool:` is absent. */
  readonly entry: string;
}

/**
 * Every tool entry of every `taiki-e/install-action` step in one file. `tool:`
 * takes a comma-separated list, so one step can name several tools. A step with
 * no `tool:` input yields one empty entry, which the pin check then rejects.
 * `stepIndent` is 6 for a workflow and 4 for a composite-action manifest.
 */
export function installActionTools(
  file: string,
  text: string,
  stepIndent: 4 | 6
): InstallActionTool[] {
  return extractStepBlocksUsing(text, INSTALL_ACTION, stepIndent).flatMap((step) => {
    const entries = (parseWithInputs(step).tool ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return (entries.length > 0 ? entries : ['']).map((entry) => ({ file, entry }));
  });
}

/** The tools requested across every workflow and composite action in the repository. */
export function repositoryInstallActionTools(): InstallActionTool[] {
  const read = (file: string): string => readFileSync(join(ROOT_DIR, file), 'utf8');
  return [
    ...workflowFiles().flatMap((file) => installActionTools(file, read(file), 6)),
    ...compositeActionFiles().flatMap((file) => installActionTools(file, read(file), 4)),
  ];
}

/**
 * Violations of the install policy, one message per problem, naming the file and
 * the received value: an entry that is not an exact `name@x.y.z`, and a tool
 * requested at two different versions.
 */
export function installActionPinViolations(tools: readonly InstallActionTool[]): string[] {
  const violations: string[] = [];
  const versionsByName = new Map<string, Map<string, string[]>>();

  for (const { file, entry } of tools) {
    const match = EXACT_TOOL_PIN.exec(entry);
    if (!match?.groups) {
      violations.push(
        `${file}: expected tool: <name>@<major>.<minor>.<patch> | received: ${JSON.stringify(entry)}`
      );
      continue;
    }
    const { name, version } = match.groups;
    const versions = versionsByName.get(name) ?? new Map<string, string[]>();
    versions.set(version, [...(versions.get(version) ?? []), file]);
    versionsByName.set(name, versions);
  }

  for (const [name, versions] of versionsByName) {
    if (versions.size < 2) continue;
    const spread = [...versions].map(([version, files]) => `${version} (${files.join(', ')})`);
    violations.push(
      `${name}: expected one version across the repository | received: ${spread.join('; ')}`
    );
  }
  return violations;
}
