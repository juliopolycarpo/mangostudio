// CLI argument parsing shared by the script runners: workspace selection plus
// generic boolean/value flags and positional collection.

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from './config';
import { error } from './log';

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

/**
 * Parse process.argv into workspace selection, flags, and positional args.
 * No selection flags defaults to every workspace plus root.
 * // Usage: const { workspaces, flags } = parseArgs({ booleanFlags: ['--staged'] });
 */
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
    else if (arg === '--runtime') workspaces.push('runtime');
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

/** Print an error and exit non-zero. // Usage: fatal('Unknown flag'); */
export function fatal(msg: string): never {
  error(msg);
  process.exit(1);
}

/** Abort if any positional args were left unconsumed. */
export function assertNoUnexpectedArguments(positional: string[]): void {
  if (positional.length > 0) {
    fatal(`Unknown argument(s): ${positional.join(' ')}`);
  }
}

/** Read and trim a required environment variable, throwing when it is unset or blank. */
export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
