/**
 * `mangostudio-runtime setup` — the act that turns an installed runtime into a
 * serving one.
 *
 * The whole trust model rests on this command being run by somebody with an
 * account on this machine. A hub asks for capabilities; this answers. There is
 * deliberately no path by which a hub writes the answer itself: the one
 * exception, running `setup` over ssh, works because the hub is holding that
 * machine owner's key, and it goes through this same CLI rather than around it.
 *
 * That is what the non-interactive shape is for. `--profile`, `--yes`, and
 * `--json` exist so an ssh channel, a container image, or a provisioner can run
 * the identical code path a person runs, and read back what it wrote.
 */

import {
  profileForAllow,
  RUNTIME_CAPABILITY_KEYS,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
  type RuntimeConsentProfile,
  type RuntimeSetupAuthority,
  type RuntimeSlot,
  SHELL_TRUST_NOTICE,
} from '@mangostudio/shared/runtime-home';
import { loadRuntimeConfig } from './config';
import { collectRuntimeHealth, type RuntimeHealthOptions } from './health';
import {
  resolveRuntimeBinaryPath,
  resolveRuntimeSlot,
  resolveRuntimeSource,
  runtimeSlotDir,
  writeRuntimeSlotConfig,
} from './runtime-home';

/** A preset a person can name; `custom` is only ever derived. */
export type RuntimeSetupProfileArg = Exclude<RuntimeConsentProfile, 'custom'>;

export interface RuntimeSetupArgs {
  readonly profile?: RuntimeSetupProfileArg;
  /** `--allow k=v` overrides applied over the chosen preset. */
  readonly allow?: Readonly<Partial<RuntimeCapabilityAllow>>;
  /**
   * Which slot this answer is for. Without it, the one this binary sits in —
   * which is right for an installed runtime and wrong for a downloaded one:
   * `connect` and `serve` answer for `remote` wherever the binary happens to
   * live, so a runtime on a PATH needs to be able to say so.
   */
  readonly slot?: RuntimeSlot;
  readonly yes: boolean;
  readonly json: boolean;
}

export interface RuntimeSetupDeps extends RuntimeHealthOptions {
  /** Asks one question and returns the answer; absent means nothing can ask. */
  readonly ask?: (question: string) => Promise<string | null>;
  readonly write: (line: string) => void;
}

export function isRuntimeSetupProfile(value: string): value is RuntimeSetupProfileArg {
  return value === 'full' || value === 'readonly' || value === 'none';
}

/** Parses `--allow fsWrite=false,shell=true` into an override set. */
export function parseAllowOverrides(
  value: string
): { readonly allow: Partial<RuntimeCapabilityAllow> } | { readonly error: string } {
  const allow: Partial<RuntimeCapabilityAllow> = {};
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [key, raw] = trimmed.split('=', 2);
    if (!key || raw === undefined) {
      return { error: `--allow expects key=value pairs, got "${trimmed}".` };
    }
    if (!(RUNTIME_CAPABILITY_KEYS as readonly string[]).includes(key)) {
      return {
        error: `--allow does not know the capability "${key}". Known: ${RUNTIME_CAPABILITY_KEYS.join(', ')}.`,
      };
    }
    const parsed = parseBoolean(raw);
    if (parsed === null) {
      return { error: `--allow ${key} expects true or false, got "${raw}".` };
    }
    allow[key as keyof RuntimeCapabilityAllow] = parsed;
  }
  return { allow };
}

function parseBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return null;
}

/**
 * Runs setup and returns the process exit code.
 *
 * The order of precedence is the order of explicitness: flags, then the
 * environment answer, then a person at a terminal. `--yes` with nothing to say
 * yes to is an error rather than a silent default — the answer this command
 * records is the one a hub will act on.
 */
export async function runRuntimeSetup(
  args: RuntimeSetupArgs,
  deps: RuntimeSetupDeps
): Promise<number> {
  const env = deps.env;
  const slot = args.slot ?? resolveRuntimeSlot(env);
  const fromEnvironment = loadRuntimeConfig(env).setupProfile;
  const environmentProfile =
    fromEnvironment !== null && isRuntimeSetupProfile(fromEnvironment) ? fromEnvironment : null;

  // An unusable environment answer is only fatal when nothing outranks it.
  // Flags come first by design, and the command that repairs a machine whose
  // `MANGOSTUDIO_RUNTIME_SETUP` went stale is precisely an explicit
  // `setup --profile … --yes` — which this used to reject before reading it.
  if (args.profile === undefined && fromEnvironment !== null && environmentProfile === null) {
    return fail(
      deps,
      args.json,
      `MANGOSTUDIO_RUNTIME_SETUP is "${fromEnvironment}", which is not a profile. Use full, readonly, or none.`
    );
  }

  const named = args.profile ?? environmentProfile;
  // `--json` is for a caller reading one document off stdout; a prompt printed
  // into that stream would corrupt it before the answer could help anyone.
  const interactive = named === null && !args.yes && !args.json && deps.ask !== undefined;

  if (named === null && !interactive) {
    return fail(
      deps,
      args.json,
      'Nothing to answer with: pass --profile full|readonly|none, or set MANGOSTUDIO_RUNTIME_SETUP, or run this where it can prompt.'
    );
  }

  const chosen = interactive ? await promptForProfile(slot, deps) : named;
  if (chosen === null) {
    return fail(deps, args.json, 'Setup cancelled; nothing was written.');
  }

  const base = RUNTIME_CONSENT_PRESETS[chosen];
  const update =
    interactive && chosen !== 'none'
      ? { update: await promptForUpdates(deps, base.update) }
      : undefined;
  const allow = { ...base, ...update, ...args.allow } satisfies RuntimeCapabilityAllow;
  const by: RuntimeSetupAuthority =
    args.profile === undefined && environmentProfile !== null ? 'env' : 'cli';
  const binaryPath = resolveRuntimeBinaryPath(env);

  // A merge, so answering the consent question leaves the hub URL a `connect`
  // remembered and the digest an installer recorded exactly where they were.
  await writeRuntimeSlotConfig(
    slot,
    {
      profile: profileForAllow(allow),
      allow,
      setup: { state: 'configured', at: new Date().toISOString(), by },
      source: resolveRuntimeSource(env),
      version: deps.runtimeVersion,
      ...(binaryPath ? { binaryPath } : {}),
    },
    env
  );

  const report = await collectRuntimeHealth({ ...deps, slot });
  if (args.json) {
    deps.write(JSON.stringify(report));
    return 0;
  }

  deps.write(`Recorded ${report.profile} consent for the ${slot} runtime.`);
  deps.write(`  ${runtimeSlotDir(slot, env)}`);
  if (allow.shell) deps.write(`  ${SHELL_TRUST_NOTICE}`);
  return 0;
}

function fail(deps: RuntimeSetupDeps, json: boolean, message: string): number {
  if (json) deps.write(JSON.stringify({ error: message }));
  else deps.write(message);
  return 1;
}

const PROFILE_CHOICES: readonly {
  readonly key: string;
  readonly profile: RuntimeSetupProfileArg;
  readonly summary: string;
}[] = [
  {
    key: '1',
    profile: 'full',
    summary: 'everything: read and write files, run commands, git, MCP, and the library',
  },
  {
    key: '2',
    profile: 'readonly',
    summary: 'read files, git, and probing only — no writes, no shell, no MCP',
  },
  { key: '3', profile: 'none', summary: 'refuse everything; the runtime stays installed and idle' },
];

async function promptForProfile(
  slot: string,
  deps: RuntimeSetupDeps
): Promise<RuntimeSetupProfileArg | null> {
  deps.write(`MangoStudio runtime setup — ${slot} slot`);
  deps.write('');
  deps.write('A MangoStudio hub can reach this machine. Choose what it may do here:');
  for (const choice of PROFILE_CHOICES) {
    deps.write(`  ${choice.key}) ${choice.profile.padEnd(9)} ${choice.summary}`);
  }
  deps.write('');
  deps.write(SHELL_TRUST_NOTICE);
  deps.write('');

  const answer = (await deps.ask?.('Profile [1/2/3]: '))?.trim().toLowerCase();
  if (answer === undefined) return null;
  const match = PROFILE_CHOICES.find(
    (choice) => choice.key === answer || choice.profile === answer
  );
  return match?.profile ?? null;
}

/**
 * D17's half of the question. A hub that may replace these bytes can close a
 * protocol-compatibility gap without anyone walking to the machine — which is
 * exactly why it is asked rather than assumed.
 */
async function promptForUpdates(deps: RuntimeSetupDeps, fallback: boolean): Promise<boolean> {
  const question = `Let the hub update this runtime when it offers a new version? [${fallback ? 'Y/n' : 'y/N'}]: `;
  const answer = (await deps.ask?.(question))?.trim().toLowerCase();
  if (!answer) return fallback;
  return parseBoolean(answer) ?? answer.startsWith('y');
}
