//! Identity-isolation attestation for this runtime's credential home.
//!
//! A port of `apps/runtime/src/services/external-agents/isolation.ts`. The
//! external-agents cycle rests on the vendor owning authentication, which is
//! only sound when the vendor credentials this process would use belong to
//! the MangoStudio user whose turn runs. This module reports what it can
//! **establish** and nothing more: there is no "assume yes" branch, no
//! configuration flag and no operator override that fabricates proof. Absence
//! is the default, and the hub maps it to `isolation-unproven`.
//!
//! A runtime process only ever reports `os-account` or `container`.
//! `single-user-host` is a claim about the *hub* serving one user, which only
//! the hub's in-process connector can make.
//!
//! The fingerprint input is byte-identical to the TypeScript derivation so a
//! hub comparing fingerprints across environments sees one credential home as
//! one value whichever runtime implementation reported it.
//!
//! # Hub withdrawal
//!
//! The hub may answer the handshake with `externalAgentIsolation:
//! "withdrawn"`. The hello manifest built here is sent before the peer's
//! hello arrives, so it cannot react; the hub strips the attestation on its
//! side (`applyHubIsolationClaim` in `apps/api/.../hub-session.ts`). The
//! per-call surface, `runtime.health`'s `externalAgents` subtree, reads the
//! peer's hello on every call and omits the attestation once it is withdrawn
//! (see `external_agents::hub_withdrew_isolation`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use mango_agent_codex::account::AccountFingerprintKey;
use mangostudio_runtime_contract::manifest::{ExternalIdentityIsolation, IdentityIsolationMethod};
use sha2::{Digest, Sha256};

/// Vendor credential locations relative to the credential home.
const VENDOR_CREDENTIAL_PATHS: [&str; 7] = [
    ".claude",
    ".claude.json",
    ".codex",
    ".cursor",
    ".config/claude",
    ".config/codex",
    ".config/cursor",
];

/// Variables that relocate a vendor's own credential home.
const VENDOR_HOME_VARIABLES: [&str; 2] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];

/// Vendor subdirectories guarded under `$XDG_CONFIG_HOME`. The base itself is
/// not guarded: a config volume without vendor directories exposes nothing.
const XDG_VENDOR_SUBDIRECTORIES: [&str; 3] = ["claude", "codex", "cursor"];

/// Domain prefix separating [`host_local_digest_key`] from the published
/// fingerprint.
const HOST_DIGEST_KEY_DOMAIN: &str = "mangostudio/host-digest-key\0";

/// The attestation this process can make about the live machine.
///
/// Reads the home through [`crate::runtime_home::home_dir`] and the
/// environment through the existing probing snapshot, so no new environment
/// read site exists. Blocking: it stats the home and reads `/proc`.
///
/// # Example
///
/// ```ignore
/// let isolation = detect_external_agent_isolation();
/// manifest.identity_isolation = isolation;
/// ```
pub(crate) fn detect_external_agent_isolation() -> Option<ExternalIdentityIsolation> {
    let home = crate::runtime_home::home_dir().ok()?;
    let env = crate::probing::host::build_runtime_path_env(None).env;
    let containerized = is_containerized();
    let mount_info = if containerized {
        read_mount_info()
    } else {
        None
    };
    resolve_external_agent_isolation(&home, containerized, mount_info.as_deref(), &env)
}

/// Chooses the attestation by what this machine is: container first, because
/// a container is also an OS account and the container check is the stricter
/// one. Never returns `single-user-host`.
///
/// # Example
///
/// ```ignore
/// let isolation = resolve_external_agent_isolation(&home, false, None, &env);
/// ```
pub(crate) fn resolve_external_agent_isolation(
    home: &Path,
    containerized: bool,
    mount_info: Option<&str>,
    env: &HashMap<String, String>,
) -> Option<ExternalIdentityIsolation> {
    if containerized {
        return container_isolation(home, mount_info, env);
    }
    os_account_isolation(home)
}

/// Attests that this process runs as its own OS account with a readable
/// credential home. `None` when the home cannot be resolved or statted.
///
/// # Example
///
/// ```ignore
/// let isolation = os_account_isolation(Path::new("/home/ada"));
/// ```
pub(crate) fn os_account_isolation(home: &Path) -> Option<ExternalIdentityIsolation> {
    attestation(IdentityIsolationMethod::OsAccount, home)
}

/// Attests a per-user container whose isolation is intact. `None` when the
/// mount table is unavailable or exposes a vendor credential path.
///
/// # Example
///
/// ```ignore
/// let isolation = container_isolation(&home, Some(&mountinfo), &env);
/// ```
pub(crate) fn container_isolation(
    home: &Path,
    mount_info: Option<&str>,
    env: &HashMap<String, String>,
) -> Option<ExternalIdentityIsolation> {
    let mount_info = mount_info?;
    if has_vendor_credential_mount(home, mount_info, env) {
        return None;
    }
    attestation(IdentityIsolationMethod::Container, home)
}

/// True when a mount point in `mount_info` exposes a vendor credential path.
///
/// A mount at or under a vendor path refuses (one credential file is enough).
/// A mount at or above the credential home or a vendor path refuses (an
/// ancestor brings them along), except `/`, which every container has as its
/// own rootfs. An unresolvable home yields `false`; the caller's attestation
/// then fails on the same home anyway. Paths compare as `/`-separated strings:
/// mountinfo is Linux-only.
///
/// # Example
///
/// ```ignore
/// assert!(has_vendor_credential_mount(&home, "36 35 0:32 / /home/ada/.claude rw - ext4 x rw", &env));
/// ```
pub(crate) fn has_vendor_credential_mount(
    home: &Path,
    mount_info: &str,
    env: &HashMap<String, String>,
) -> bool {
    let Some(home) = realpath(home) else {
        return false;
    };
    let vendor_paths = vendor_credential_paths(&home, env);
    let mut ancestor_targets = vec![home];
    ancestor_targets.extend(vendor_paths.iter().cloned());

    mount_info
        .split('\n')
        .filter_map(|line| line.split(' ').nth(4))
        .map(decode_mount_point)
        .filter(|mount_point| mount_point != "/")
        .any(|mount_point| {
            vendor_paths
                .iter()
                .any(|path| is_at_or_under(&mount_point, path))
                || ancestor_targets
                    .iter()
                    .any(|path| is_at_or_under(path, &mount_point))
        })
}

/// A key for digests that must not be reproducible off this machine: hex
/// `sha256("mangostudio/host-digest-key\0" + identity)`. Callers must degrade
/// rather than fall back to an unkeyed digest when it is `None`.
///
/// # Example
///
/// ```ignore
/// let key = host_local_digest_key(&home).expect("readable home");
/// ```
pub(crate) fn host_local_digest_key(home: &Path) -> Option<String> {
    host_identity(home).map(|identity| digest_key_for(&identity))
}

/// The Codex account-fingerprint key for this machine, from the live home.
///
/// Reads the home through [`crate::runtime_home::home_dir`], as
/// [`detect_external_agent_isolation`] does. `None` when the home cannot be
/// read, and then no fingerprint is sent at all. Blocking: it stats the home.
///
/// # Example
///
/// ```ignore
/// let key = detect_account_fingerprint_key();
/// ```
pub(crate) fn detect_account_fingerprint_key() -> Option<AccountFingerprintKey> {
    let home = crate::runtime_home::home_dir().ok()?;
    account_fingerprint_key(&host_local_digest_key(&home)?)
}

/// The SDK key for a [`host_local_digest_key`]: the hex text's own bytes, the
/// way `codex/adapter.ts` handed the same string to `createHmac`, so every
/// fingerprint equals the one the TypeScript adapter stored on a continuation.
///
/// # Example
///
/// ```ignore
/// let key = account_fingerprint_key(&host_local_digest_key(&home)?)?;
/// ```
pub(crate) fn account_fingerprint_key(digest_key: &str) -> Option<AccountFingerprintKey> {
    AccountFingerprintKey::new(digest_key.as_bytes()).ok()
}

fn attestation(method: IdentityIsolationMethod, home: &Path) -> Option<ExternalIdentityIsolation> {
    let identity = host_identity(home)?;
    Some(ExternalIdentityIsolation {
        method,
        credential_home_fingerprint: fingerprint_for(&identity),
    })
}

fn fingerprint_for(identity: &str) -> String {
    format!("sha256:{}", sha256_hex(identity.as_bytes()))
}

fn digest_key_for(identity: &str) -> String {
    sha256_hex(format!("{HOST_DIGEST_KEY_DOMAIN}{identity}").as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The unpublished material every digest is built from. Not domain-separated
/// by method, so one shared account collides across methods at the hub.
fn host_identity(home: &Path) -> Option<String> {
    let home = realpath(home)?;
    let (dev, ino) = stat_identity(Path::new(&home))?;
    Some(identity_string(
        crate::health::node_platform(),
        current_uid(),
        &home,
        dev,
        ino,
    ))
}

/// `[platform, uid | "no-uid", home, dev, ino].join("\0")` exactly as the
/// TypeScript runtime builds it. `dev` and `ino` go through `f64` because
/// Bun's `statSync` returns JavaScript numbers: a value above 2^53 is rounded
/// there, and Rust's shortest round-trip `f64` display prints the same digits
/// as JavaScript's `String(number)` for integers below 1e21.
fn identity_string(platform: &str, uid: Option<u32>, home: &str, dev: u64, ino: u64) -> String {
    let uid = uid.map_or_else(|| "no-uid".to_owned(), |uid| uid.to_string());
    #[expect(
        clippy::cast_precision_loss,
        reason = "matches the JavaScript number the TypeScript runtime formats"
    )]
    let (dev, ino) = (dev as f64, ino as f64);
    format!("{platform}\0{uid}\0{home}\0{dev}\0{ino}")
}

#[cfg(unix)]
fn current_uid() -> Option<u32> {
    Some(nix::unistd::getuid().as_raw())
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

/// Device and inode of the directory at `path`. On Windows this is the volume
/// serial and 64-bit file index from [`crate::file_identity`], which is what
/// Bun's `statSync` reports as `dev` and `ino`.
fn stat_identity(path: &Path) -> Option<(u64, u64)> {
    let file = crate::file_identity::open_for_identity(path).ok()?;
    let metadata = file.metadata().ok()?;
    let identity = crate::file_identity::object_identity(&file, &metadata).ok()?;
    Some((identity.device(), identity.inode()))
}

/// `realpathSync` stand-in: `canonicalize`, as a string.
///
/// On Windows the verbatim `\\?\` prefix `canonicalize` adds is removed so the
/// string reads like Bun's. Two known gaps remain there: Bun keeps 8.3 short
/// names and the caller's casing where `canonicalize` expands and normalizes
/// them, so a home reached through a short name fingerprints differently than
/// under the TypeScript runtime. The crate has no TS-compatible resolver to
/// reuse; Unix, where the attestation matters most, has no such gap.
fn realpath(path: &Path) -> Option<String> {
    let resolved = std::fs::canonicalize(path).ok()?;
    Some(strip_verbatim_prefix(&resolved.to_string_lossy()))
}

fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(share) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{share}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_owned()
}

/// Vendor directories themselves: defaults under `home`, then relocations.
/// A relocation whose realpath fails is kept verbatim, never dropped.
fn vendor_credential_paths(home: &str, env: &HashMap<String, String>) -> Vec<String> {
    let mut paths: Vec<String> = VENDOR_CREDENTIAL_PATHS
        .iter()
        .map(|relative| join(home, relative))
        .collect();
    for variable in VENDOR_HOME_VARIABLES {
        if let Some(relocated) = non_empty(env, variable) {
            paths.push(realpath(Path::new(relocated)).unwrap_or_else(|| relocated.to_owned()));
        }
    }
    let Some(xdg) = non_empty(env, "XDG_CONFIG_HOME") else {
        return paths;
    };
    let base = realpath(Path::new(xdg)).unwrap_or_else(|| xdg.to_owned());
    paths.extend(
        XDG_VENDOR_SUBDIRECTORIES
            .iter()
            .map(|vendor| join(&base, vendor)),
    );
    paths
}

fn non_empty<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

fn join(base: &str, relative: &str) -> String {
    PathBuf::from(base)
        .join(relative)
        .to_string_lossy()
        .into_owned()
}

/// True when `candidate` is `parent` or sits underneath it.
fn is_at_or_under(candidate: &str, parent: &str) -> bool {
    if candidate == parent {
        return true;
    }
    if parent.ends_with('/') {
        return candidate.starts_with(parent);
    }
    candidate
        .strip_prefix(parent)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// Decodes the octal escapes mountinfo uses for space, tab, newline and
/// backslash.
fn decode_mount_point(raw: &str) -> String {
    const ESCAPES: [(&str, char); 4] = [("040", ' '), ("011", '\t'), ("012", '\n'), ("134", '\\')];
    let mut decoded = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(index) = rest.find('\\') {
        decoded.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        match ESCAPES.iter().find(|(code, _)| after.starts_with(code)) {
            Some((code, character)) => {
                decoded.push(*character);
                rest = &after[code.len()..];
            }
            None => {
                decoded.push('\\');
                rest = after;
            }
        }
    }
    decoded.push_str(rest);
    decoded
}

/// Docker's `/.dockerenv`, Podman's `/run/.containerenv`, or an engine name in
/// the cgroup path. Container proof reads `/proc/self/mountinfo`, which only
/// Linux has, so elsewhere this is always `false` and the runtime reports
/// `os-account` or nothing, never `container`.
#[cfg(target_os = "linux")]
fn is_containerized() -> bool {
    if Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists() {
        return true;
    }
    std::fs::read_to_string("/proc/self/cgroup").is_ok_and(|cgroup| cgroup_names_engine(&cgroup))
}

#[cfg(not(target_os = "linux"))]
fn is_containerized() -> bool {
    false
}

#[cfg_attr(
    all(not(target_os = "linux"), not(test)),
    expect(dead_code, reason = "cgroups are Linux-only")
)]
fn cgroup_names_engine(cgroup: &str) -> bool {
    ["docker", "containerd", "podman", "lxc", "kubepods"]
        .iter()
        .any(|engine| cgroup.contains(engine))
}

#[cfg(target_os = "linux")]
fn read_mount_info() -> Option<String> {
    std::fs::read_to_string("/proc/self/mountinfo").ok()
}

#[cfg(not(target_os = "linux"))]
fn read_mount_info() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    //! Ports `apps/runtime/tests/unit/services/external-agent-isolation.test.ts`.
    //! Container cases are Unix-only: mountinfo paths are `/`-separated.

    use super::*;

    fn no_env() -> HashMap<String, String> {
        HashMap::new()
    }

    #[cfg(unix)]
    fn env_of(key: &str, value: &str) -> HashMap<String, String> {
        HashMap::from([(key.to_owned(), value.to_owned())])
    }

    /// One `/proc/self/mountinfo` line for a mount point, in the real layout.
    fn mount_line(mount_point: &str) -> String {
        format!("36 35 0:32 / {mount_point} rw,relatime shared:1 - ext4 /dev/sda1 rw")
    }

    fn absent_home() -> PathBuf {
        std::env::temp_dir().join("mangostudio-absent-credential-home")
    }

    fn real_home() -> PathBuf {
        crate::runtime_home::home_dir().expect("this test host has a home directory")
    }

    /// A fresh credential home, canonical so mount lines match its realpath.
    fn temp_home(prefix: &str) -> (crate::test_support::ScratchDir, String) {
        let dir = crate::test_support::scratch_dir(prefix);
        let path = realpath(dir.path()).expect("temp home resolves");
        (dir, path)
    }

    fn method_of(isolation: Option<&ExternalIdentityIsolation>) -> Option<IdentityIsolationMethod> {
        isolation.map(|isolation| isolation.method)
    }

    fn assert_fingerprint_shape(fingerprint: &str) {
        let digest = fingerprint.strip_prefix("sha256:").unwrap_or_else(|| {
            panic!("expected fingerprint shape: sha256:<64 hex> | received: {fingerprint}")
        });
        assert!(
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')),
            "expected fingerprint shape: sha256:<64 hex> | received: {fingerprint}"
        );
    }

    // single-user-host identity isolation

    #[test]
    fn single_user_host_fingerprints_the_home_without_exposing_it() {
        let isolation = attestation(IdentityIsolationMethod::SingleUserHost, &real_home())
            .expect("expected attestation for a readable home | received: none");
        assert_eq!(isolation.method, IdentityIsolationMethod::SingleUserHost);
        assert_fingerprint_shape(&isolation.credential_home_fingerprint);
    }

    #[test]
    fn single_user_host_degrades_when_the_home_is_unreadable() {
        assert_eq!(
            attestation(IdentityIsolationMethod::SingleUserHost, &absent_home()),
            None,
            "unreadable home must yield no attestation, not a weaker one"
        );
    }

    // os-account identity isolation

    #[test]
    fn os_account_attests_the_account_this_process_runs_as() {
        let isolation = os_account_isolation(&real_home())
            .expect("expected os-account attestation for a readable home | received: none");
        assert_eq!(isolation.method, IdentityIsolationMethod::OsAccount);
        assert_fingerprint_shape(&isolation.credential_home_fingerprint);
    }

    #[test]
    fn os_account_degrades_rather_than_failing_on_an_unreadable_home() {
        assert_eq!(
            os_account_isolation(&absent_home()),
            None,
            "unreadable home must yield no attestation, not a weaker one"
        );
    }

    #[test]
    fn same_home_produces_the_same_digest_whatever_the_method() {
        let home = real_home();
        assert_eq!(
            os_account_isolation(&home).map(|isolation| isolation.credential_home_fingerprint),
            attestation(IdentityIsolationMethod::SingleUserHost, &home)
                .map(|isolation| isolation.credential_home_fingerprint),
            "fingerprints must not be domain-separated by method"
        );
    }

    #[test]
    fn fingerprint_leaks_the_home_path_into_neither_digest_nor_prefix() {
        let home = real_home();
        let fingerprint = os_account_isolation(&home)
            .map(|isolation| isolation.credential_home_fingerprint)
            .unwrap_or_default();
        assert!(
            !fingerprint.contains(home.to_string_lossy().as_ref()),
            "expected fingerprint without the home path | received: {fingerprint}"
        );
        assert_fingerprint_shape(&fingerprint);
    }

    // Byte identity with the TypeScript derivation. Expected digests were
    // computed independently with both `printf ... | sha256sum` and `bun -e`
    // (node:crypto) over the same `join("\0")` input.

    #[test]
    fn fingerprint_matches_the_typescript_derivation_byte_for_byte() {
        let identity = identity_string("linux", Some(1000), "/home/ada", 66306, 12345);
        assert_eq!(identity, "linux\u{0}1000\u{0}/home/ada\u{0}66306\u{0}12345");
        assert_eq!(
            fingerprint_for(&identity),
            "sha256:881d44614682d550dc48486ecd5fde20d8b1e86a2a3d41c541578ea74c7bc431"
        );
        assert_eq!(
            digest_key_for(&identity),
            "79c4430d903946ca831095f75c583bc244f415701866baf23852fdb88d191734"
        );
    }

    /// Bun reports `dev`/`ino` as JavaScript numbers, so values above 2^53
    /// round; `String(Number(18446744073709551615n))` is `18446744073709552000`.
    #[test]
    fn large_inodes_and_no_uid_format_like_javascript_numbers() {
        let identity = identity_string("win32", None, r"C:\Users\ada", 3_405_691_582, u64::MAX);
        assert_eq!(
            identity,
            "win32\u{0}no-uid\u{0}C:\\Users\\ada\u{0}3405691582\u{0}18446744073709552000"
        );
        assert_eq!(
            fingerprint_for(&identity),
            "sha256:0a88146e3c2930f6cfba4ee9faa73ef958d11fb63f601349cd60f99d27c55f1f"
        );
    }

    #[test]
    fn an_empty_digest_key_yields_no_account_fingerprint_key() {
        assert!(
            account_fingerprint_key("").is_none(),
            "expected no key, so no unkeyed fingerprint, for an empty digest key"
        );
        let key = account_fingerprint_key("host-local-key").expect("a non-empty key");
        assert_eq!(
            key.fingerprint("user@example.com").as_str(),
            "bcd4e5c63495974573261faadb33d8be",
            "expected the key to be the digest text's bytes, as `createHmac` used it"
        );
        // End to end from a host identity: `codex/adapter.ts` computed
        // `createHmac('sha256', hostLocalDigestKey()).update('codex:' + email)`
        // `.digest('hex').slice(0, 32)` with this identity's digest key.
        let identity = identity_string("linux", Some(1000), "/home/ada", 66306, 12345);
        let key = account_fingerprint_key(&digest_key_for(&identity)).expect("a host key");
        assert_eq!(
            key.fingerprint("user@example.com").as_str(),
            "5804f50595bc9d505930fc1468620036",
            "expected the fingerprint the TypeScript adapter stored for this host"
        );
    }

    #[test]
    fn host_local_digest_key_is_domain_separated_and_absent_for_an_unreadable_home() {
        let home = real_home();
        let key = host_local_digest_key(&home).expect("readable home yields a key");
        let fingerprint = os_account_isolation(&home)
            .expect("readable home yields an attestation")
            .credential_home_fingerprint;
        assert_ne!(
            format!("sha256:{key}"),
            fingerprint,
            "key must not equal the published fingerprint"
        );
        assert_eq!(host_local_digest_key(&absent_home()), None);
    }

    #[test]
    fn strips_the_windows_verbatim_prefix() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\ada"), r"C:\Users\ada");
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share"),
            r"\\server\share"
        );
        assert_eq!(strip_verbatim_prefix("/home/ada"), "/home/ada");
    }

    #[test]
    fn cgroup_detection_names_every_engine() {
        for engine in ["docker", "containerd", "podman", "lxc", "kubepods"] {
            assert!(
                cgroup_names_engine(&format!("0::/{engine}/abc")),
                "{engine} not detected"
            );
        }
        assert!(!cgroup_names_engine("0::/user.slice/user-1000.slice"));
    }

    // container identity isolation

    #[cfg(unix)]
    #[test]
    fn container_attests_when_the_credential_home_is_its_own() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        let isolation =
            container_isolation(Path::new(&home), Some(&mount_line("/proc")), &no_env());
        assert_eq!(
            method_of(isolation.as_ref()),
            Some(IdentityIsolationMethod::Container)
        );
    }

    #[cfg(unix)]
    #[test]
    fn container_refuses_a_bind_mounted_vendor_directory() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        for vendor in [".claude", ".codex", ".cursor", ".config/cursor"] {
            let isolation = container_isolation(
                Path::new(&home),
                Some(&mount_line(&join(&home, vendor))),
                &no_env(),
            );
            assert_eq!(
                isolation, None,
                "vendor rule: a mounted {vendor} must refuse"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn container_refuses_when_the_whole_home_is_mounted() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        assert_eq!(
            container_isolation(Path::new(&home), Some(&mount_line(&home)), &no_env()),
            None,
            "ancestor rule: a mount at the credential home must refuse"
        );
    }

    #[cfg(unix)]
    #[test]
    fn container_refuses_when_the_mount_table_cannot_be_read() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        assert_eq!(
            container_isolation(Path::new(&home), None, &no_env()),
            None,
            "an unverifiable container must be unproven"
        );
    }

    #[cfg(unix)]
    #[test]
    fn decodes_the_octal_escapes_mountinfo_uses_for_spaces() {
        let (_dir, spaced) = temp_home("mango space-");
        let escaped = format!("{}/.claude", spaced.replace(' ', r"\040"));
        assert!(
            has_vendor_credential_mount(Path::new(&spaced), &mount_line(&escaped), &no_env()),
            "octal decoding: {escaped} must decode to the vendor path"
        );
    }

    #[test]
    fn decodes_every_mountinfo_escape() {
        assert_eq!(
            decode_mount_point(r"a\040b\011c\012d\134e\999"),
            "a b\tc\nd\\e\\999",
            "octal decoding: only the four mountinfo escapes decode"
        );
    }

    #[cfg(unix)]
    #[test]
    fn is_unmoved_by_a_mount_merely_near_a_vendor_directory() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        assert!(!has_vendor_credential_mount(
            Path::new(&home),
            &mount_line(&join(&home, ".claude-backup")),
            &no_env()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_mount_below_a_vendor_directory() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        for relative in [
            ".claude/.credentials.json",
            ".codex/auth.json",
            ".claude/settings.json/deeper",
        ] {
            assert!(
                has_vendor_credential_mount(
                    Path::new(&home),
                    &mount_line(&join(&home, relative)),
                    &no_env()
                ),
                "vendor rule: a mount at {relative} must refuse"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_mount_above_the_credential_home() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        let parent = Path::new(&home).parent().expect("temp home has a parent");
        assert!(
            has_vendor_credential_mount(
                Path::new(&home),
                &mount_line(&parent.to_string_lossy()),
                &no_env()
            ),
            "ancestor rule: a mount above the credential home must refuse"
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_treat_the_container_rootfs_as_a_shared_credential_mount() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        assert!(
            !has_vendor_credential_mount(Path::new(&home), &mount_line("/"), &no_env()),
            "root exception: `/` is every container's own rootfs"
        );
        let table = format!("{}\n{}", mount_line("/"), mount_line("/proc"));
        let isolation = container_isolation(Path::new(&home), Some(&table), &no_env());
        assert_eq!(
            method_of(isolation.as_ref()),
            Some(IdentityIsolationMethod::Container),
            "root exception: a rootfs-only table must still attest container"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guards_a_relocated_codex_home() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        assert!(
            has_vendor_credential_mount(
                Path::new(&home),
                &mount_line("/mnt/host-codex"),
                &env_of("CODEX_HOME", "/mnt/host-codex")
            ),
            "vendor rule: a relocated CODEX_HOME mount must refuse"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guards_a_relocated_claude_configuration_directory() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        assert!(
            has_vendor_credential_mount(
                Path::new(&home),
                &mount_line("/mnt/host-claude/.credentials.json"),
                &env_of("CLAUDE_CONFIG_DIR", "/mnt/host-claude")
            ),
            "vendor rule: a mount under a relocated CLAUDE_CONFIG_DIR must refuse"
        );
    }

    #[cfg(unix)]
    #[test]
    fn guards_vendor_subdirectories_of_a_relocated_xdg_config_home() {
        let (_dir, home) = temp_home("mangostudio-container-home-");
        let env = env_of("XDG_CONFIG_HOME", "/mnt/xdg");
        assert!(has_vendor_credential_mount(
            Path::new(&home),
            &mount_line("/mnt/xdg/cursor"),
            &env
        ));
        assert!(!has_vendor_credential_mount(
            Path::new(&home),
            &mount_line("/mnt/xdg/some-other-app"),
            &env
        ));
    }

    // resolveExternalAgentIsolation

    #[test]
    fn resolve_reports_os_account_off_a_container() {
        let (_dir, home) = temp_home("mangostudio-resolve-home-");
        let isolation = resolve_external_agent_isolation(Path::new(&home), false, None, &no_env());
        assert_eq!(
            method_of(isolation.as_ref()),
            Some(IdentityIsolationMethod::OsAccount)
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_takes_the_stricter_container_path_when_containerized() {
        let (_dir, home) = temp_home("mangostudio-resolve-home-");
        let clean = resolve_external_agent_isolation(
            Path::new(&home),
            true,
            Some(&mount_line("/proc")),
            &no_env(),
        );
        assert_eq!(
            method_of(clean.as_ref()),
            Some(IdentityIsolationMethod::Container)
        );
        let shared = mount_line(&join(&home, ".claude"));
        assert_eq!(
            resolve_external_agent_isolation(Path::new(&home), true, Some(&shared), &no_env()),
            None,
            "a containerized runtime must not fall back to os-account past the mount check"
        );
    }

    #[test]
    fn resolve_never_claims_single_user_host_from_a_runtime_process() {
        let (_dir, home) = temp_home("mangostudio-resolve-home-");
        for containerized in [false, true] {
            let isolation = resolve_external_agent_isolation(
                Path::new(&home),
                containerized,
                Some(&mount_line("/proc")),
                &no_env(),
            );
            assert_ne!(
                method_of(isolation.as_ref()),
                Some(IdentityIsolationMethod::SingleUserHost),
                "a runtime process must never claim single-user-host (containerized: {containerized})"
            );
        }
    }

    #[test]
    fn resolve_attests_nothing_when_the_credential_home_is_unreadable() {
        assert_eq!(
            resolve_external_agent_isolation(&absent_home(), false, None, &no_env()),
            None,
            "unreadable home must yield no attestation, not a weaker one"
        );
    }
}
