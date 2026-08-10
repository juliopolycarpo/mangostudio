/**
 * Proving that a vendor login belongs to the person whose turn is running.
 *
 * The whole external-agents cycle rests on the vendor owning authentication.
 * That is only true if the vendor's credentials belong to the MangoStudio user
 * who started the turn — and MangoStudio's ownership model is logical, not
 * operational. The environment table and the runtime connection manager key by
 * MangoStudio user and environment; neither proves anything about OS accounts.
 * On a multi-user hub with a shared SSH host, two MangoStudio users reach one
 * `~/.codex`, one `~/.cursor` and one `~/.claude`, so one person's ChatGPT
 * allowance runs another person's turn and one person's Claude Pro seat is
 * "made available to someone else" in the Consumer Terms' own words.
 *
 * This module reports what it can **establish**, and nothing more. There is no
 * "assume yes" branch and no configuration flag that fabricates an attestation:
 * absence is the default and the hub maps it to `isolation-unproven`, so the
 * feature is withheld rather than the guarantee being invented. An operator
 * override is deliberately not provided — the whole point is that the
 * attestation cannot be asserted by the party that benefits from asserting it.
 *
 * What this side can and cannot see is worth stating plainly, because the split
 * is what makes the design work:
 *
 * - **Here**: which OS account this process runs as, whether it is inside a
 *   container, and whether that container's isolation is defeated by a bind
 *   mount exposing a host credential directory.
 * - **Not here**: how many MangoStudio users reach this machine. A shared SSH
 *   service account looks *identical* to a per-user one from inside. The hub
 *   closes that gap by watching for one fingerprint claimed by two users; see
 *   `external-identity-isolation.ts`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';

/**
 * Vendor credential directories, relative to the credential home.
 *
 * Checked against the mount table inside a container: a bind-mounted `~/.claude`
 * defeats exactly the isolation the container otherwise provides, and it does so
 * invisibly — the container has its own uid namespace and its own filesystem, so
 * every other signal says "isolated" while the credentials are the host's.
 */
const VENDOR_CREDENTIAL_PATHS = [
  '.claude',
  '.claude.json',
  '.codex',
  '.cursor',
  '.config/claude',
  '.config/codex',
  '.config/cursor',
] as const;

/**
 * Environment variables that move a vendor's credential home somewhere else.
 *
 * These are the same variables the adapters pass through to their child
 * processes, so a runtime started with `CODEX_HOME=/mnt/host-codex` reads its
 * credentials from a directory none of the paths above name. Checking only the
 * defaults would leave the relocation as a way to bind-mount host credentials
 * past this function without tripping it.
 *
 * `XDG_CONFIG_HOME` is a base directory rather than a vendor's own, so its
 * vendor subdirectories are guarded rather than the base itself: a mount at
 * `$XDG_CONFIG_HOME` alone exposes no vendor credentials by itself, and
 * treating it as guarded would refuse ordinary containers that mount a config
 * volume.
 */
const VENDOR_HOME_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
const XDG_VENDOR_SUBDIRECTORIES = ['claude', 'codex', 'cursor'] as const;

/**
 * Positive attestation for the in-process connector, which serves one signed-in
 * MangoStudio user. The digest changes when the OS credential home identity does
 * without exposing the path, uid, device or inode to the hub.
 *
 * Returns `undefined` when the credential home cannot be read — unset, dangling
 * or unreadable. Attestation is optional by contract, and absence already means
 * unproven, so degrading keeps the Local environment's file, shell and git
 * access working while still withholding external agents. A throw here would
 * instead reject the whole Local connect attempt.
 *
 * `credentialHome` defaults to this account's home and is a parameter so the
 * unreadable path can be exercised without mutating the process environment.
 */
export function createSingleUserHostExternalAgentIsolation(
  credentialHome: string = homedir()
): ExternalIdentityIsolation | undefined {
  return attestation('single-user-host', credentialHome);
}

/**
 * Positive attestation for a runtime process running as a real OS account.
 *
 * This is the SSH, WSL and hub-launched-stdio case. What it establishes is that
 * this process has its own uid and its own credential home — which is the whole
 * of what an OS account can prove about itself.
 *
 * What it deliberately does **not** establish is that only one MangoStudio user
 * reaches that account. A shared deploy key, a shared service account, or an
 * `authorized_keys` file that several users' keys land in produces a runtime
 * indistinguishable from a per-user one, and no amount of looking from inside
 * changes that. The remote identity goes into the fingerprint precisely so the
 * hub can notice two users arriving at the same one.
 */
export function createOsAccountExternalAgentIsolation(
  credentialHome: string = homedir()
): ExternalIdentityIsolation | undefined {
  return attestation('os-account', credentialHome);
}

/**
 * Positive attestation for a per-user container, when its isolation is intact.
 *
 * Containerization alone is not the claim. A container with a bind mount
 * exposing a host credential directory has the host's vendor logins inside it,
 * so its own uid namespace proves nothing about whose account will run the turn
 * — and that is the failure this checks for. Absent when the mount table cannot
 * be read: an unverifiable container is an unproven one.
 *
 * Both arguments are required, with no defaults. A default `mountInfo` would
 * make an explicit `undefined` — "I have no mount table" — silently reread the
 * host's real one and attest on the strength of it, which is the opposite of
 * what the caller asked. {@link resolveExternalAgentIsolation} is where the
 * live table is read.
 */
export function createContainerExternalAgentIsolation(
  credentialHome: string,
  mountInfo: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): ExternalIdentityIsolation | undefined {
  if (mountInfo === undefined) return undefined;
  if (hasVendorCredentialMount(credentialHome, mountInfo, env)) return undefined;
  return attestation('container', credentialHome);
}

/**
 * The attestation this process can make, chosen by what this machine is.
 *
 * Container first, because a container is also an OS account and the container
 * check is the stricter one: reporting `os-account` for a containerized runtime
 * would skip the bind-mount test entirely and attest an isolation that a single
 * `-v ~/.claude:/root/.claude` defeats.
 *
 * `single-user-host` is never returned here. It is a claim about the *hub*
 * serving one user, which only the in-process connector is in a position to
 * make, and a remote runtime asserting it would be asserting something about a
 * process on another machine.
 */
export function resolveExternalAgentIsolation(
  options: {
    readonly credentialHome?: string;
    readonly containerized?: boolean;
    readonly mountInfo?: string;
    readonly env?: NodeJS.ProcessEnv;
  } = {}
): ExternalIdentityIsolation | undefined {
  const credentialHome = options.credentialHome ?? homedir();
  const containerized = options.containerized ?? isContainerized();
  return containerized
    ? createContainerExternalAgentIsolation(
        credentialHome,
        options.mountInfo ?? readMountInfo(),
        options.env ?? process.env
      )
    : createOsAccountExternalAgentIsolation(credentialHome);
}

/**
 * A key for digests that must not be reproducible off this machine.
 *
 * Some values an adapter reports are digests of low-entropy personal data — an
 * email address above all — where a plain hash is not an identifier but a
 * *confirmation oracle*: anyone holding the digest and a guess can check the
 * guess offline. Keying the digest with something only this host knows removes
 * that, while keeping the value stable across restarts so it can still do the
 * one job it has, which is noticing that the identity behind it changed.
 *
 * Derived from the same material as the attestations above — the credential
 * home's device and inode are the parts an outsider cannot guess — but through
 * a **separate domain**, so publishing `credentialHomeFingerprint` never
 * reveals this key. Callers must degrade rather than fall back to an unkeyed
 * digest when it is `undefined`.
 */
export function hostLocalDigestKey(credentialHome: string = homedir()): string | undefined {
  const identity = hostIdentity(credentialHome);
  if (identity === undefined) return undefined;
  return createHash('sha256').update(`mangostudio/host-digest-key\0${identity}`).digest('hex');
}

/**
 * Whether this process is running inside a container.
 *
 * Three independent signals, because no single one is reliable across runtimes:
 * Docker writes `/.dockerenv`, Podman writes `/run/.containerenv`, and both
 * leave their engine's name in the cgroup path. A false negative degrades to
 * `os-account`, which still refuses to attest a bind-mounted credential home
 * only because the hub's collision check catches the sharing — so the cgroup
 * scan is kept even though the marker files usually answer first.
 */
function isContainerized(): boolean {
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    return /docker|containerd|podman|lxc|kubepods/.test(cgroup);
  } catch {
    return false;
  }
}

/**
 * The vendor credential directories themselves, defaults plus relocations.
 *
 * Separate from the credential home because the two are checked differently. A
 * mount *inside* one of these exposes a credential — mounting
 * `~/.claude/.credentials.json` shares the login itself. A mount inside the
 * *home* does not: `~/.claude-backup` and `~/projects` are ordinary
 * directories, and refusing them would reject almost every real container.
 */
function vendorCredentialPaths(home: string, env: NodeJS.ProcessEnv): readonly string[] {
  const paths = VENDOR_CREDENTIAL_PATHS.map((path) => join(home, path));

  for (const variable of VENDOR_HOME_VARIABLES) {
    const relocated = env[variable];
    if (relocated && relocated.length > 0) paths.push(resolvePathSafely(relocated) ?? relocated);
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    const base = resolvePathSafely(xdg) ?? xdg;
    for (const vendor of XDG_VENDOR_SUBDIRECTORIES) paths.push(join(base, vendor));
  }
  return paths;
}

/** True when `candidate` is `parent` or sits underneath it. */
function isAtOrUnder(candidate: string, parent: string): boolean {
  if (candidate === parent) return true;
  const boundary = parent.endsWith('/') ? parent : `${parent}/`;
  return candidate.startsWith(boundary);
}

/**
 * True when a vendor credential path is exposed by a mount.
 *
 * The test is the mount table rather than the filesystem, because a bind mount
 * is invisible from the directory itself: it has ordinary permissions, an
 * ordinary owner and ordinary contents. `/proc/self/mountinfo` lists the mount
 * points this namespace actually has, and a vendor path appearing there is one
 * that came from outside the container.
 *
 * Two rules, and they are deliberately not the same rule:
 *
 * - **At or under a vendor directory** refuses. A single file is enough to
 *   defeat the isolation — `-v ~/.claude/.credentials.json:...` mounts the login
 *   itself — so equality alone would miss the cheapest way to share one.
 * - **At or above the credential home** refuses, because mounting an ancestor
 *   brings every vendor directory underneath it along. What is *inside* the home
 *   is not covered: `~/projects` is an ordinary bind mount and refusing it would
 *   reject nearly every real container.
 *
 * The filesystem root is the one exception to the ancestor rule, and it has to
 * be. Every container has `/` in its mount table — its own rootfs, not evidence
 * that anything was shared in — so counting it would refuse every container that
 * exists and make this check useless rather than strict.
 */
export function hasVendorCredentialMount(
  credentialHome: string,
  mountInfo: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const home = resolvePathSafely(credentialHome);
  if (home === undefined) return false;
  const vendorPaths = vendorCredentialPaths(home, env);
  const ancestorTargets = [home, ...vendorPaths];

  for (const line of mountInfo.split('\n')) {
    // mountinfo columns: id parent major:minor root mountPoint ...
    const mountPoint = line.split(' ')[4];
    if (mountPoint === undefined) continue;
    // Octal escapes for space, tab, newline and backslash, which mountinfo uses
    // rather than quoting. A home directory with a space in it is otherwise
    // compared against a mangled path and silently never matches.
    const decoded = mountPoint.replace(/\\(040|011|012|134)/g, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 8))
    );
    if (decoded === '/') continue;
    if (vendorPaths.some((path) => isAtOrUnder(decoded, path))) return true;
    if (ancestorTargets.some((path) => isAtOrUnder(path, decoded))) return true;
  }
  return false;
}

function readMountInfo(): string | undefined {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return undefined;
  }
}

function resolvePathSafely(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** One attestation of the given method, or nothing when the home is unreadable. */
function attestation(
  method: ExternalIdentityIsolation['method'],
  credentialHome: string
): ExternalIdentityIsolation | undefined {
  const identity = hostIdentity(credentialHome);
  if (identity === undefined) return undefined;
  return {
    method,
    credentialHomeFingerprint: `sha256:${createHash('sha256').update(identity).digest('hex')}`,
  };
}

/**
 * The unpublished material every digest above is built from.
 *
 * Deliberately unchanged from the single-user-host original, and deliberately
 * *not* domain-separated by method. Two properties depend on that:
 *
 * - `hostLocalDigestKey` derives the account-fingerprint key from the same
 *   material, and those fingerprints are persisted on continuation rows.
 *   Perturbing this input would invalidate every stored external session on
 *   upgrade — a silent reset of everybody's vendor conversations to buy nothing.
 * - The hub compares fingerprints *across* environments to find one credential
 *   home reached by two MangoStudio users. A per-method digest would let the
 *   same shared account attest `os-account` on one route and `container` on
 *   another and never collide, which is precisely the case the comparison
 *   exists to catch.
 *
 * None of it is reversible: the digest is one-way, and publishing only the
 * digest is what keeps a username and a home path off the wire.
 */
function hostIdentity(credentialHome: string): string | undefined {
  let home: string;
  let info: ReturnType<typeof statSync>;
  try {
    home = realpathSync(credentialHome);
    info = statSync(home);
  } catch {
    return undefined;
  }
  return [process.platform, process.getuid?.() ?? 'no-uid', home, info.dev, info.ino].join('\0');
}
