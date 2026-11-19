//! The per-credential-home secret that keys external-agent digests.
//!
//! `credentialHomeFingerprint` and the Codex `account.fingerprint` leave this
//! machine, so neither may be a bare hash of material an observer can guess:
//! the platform, uid and home path are all predictable, and an attacker holding
//! a descriptor could test candidate values offline. Both are HMAC-SHA256s
//! under a random 32-byte secret generated on first use and never transmitted,
//! logged or rendered.
//!
//! # Where it lives
//!
//! `<credential home>/.mango/host-secret`, not under `MANGO_HOME` and not in a
//! runtime slot. The registry that notices one credential home claimed by two
//! MangoStudio users compares fingerprints, so every runtime that reads the
//! same credential home has to derive the same fingerprint. Two slots, or two
//! `MANGO_HOME` values, on one OS account share this file and still collide.
//! A separate account has its own home and its own secret, and so does a
//! separate host, which is the point.
//!
//! # Lifecycle
//!
//! - **First use** generates the secret from the operating system's CSPRNG and
//!   publishes it owner-only (`0600`; a DACL rewrite on Windows) with a temp
//!   write and a rename, under a lock, so a concurrent first start in another
//!   process or thread ends with one secret that every caller observed.
//! - **Absent, short, long or group/world-accessible** files are replaced. An
//!   accessible secret must be treated as exposed, so it is not kept.
//! - **Replacing the secret changes every fingerprint.** The registry then
//!   sees new credential homes, and continuations stored under the old Codex
//!   account fingerprint start a fresh vendor session instead of resuming.
//!   Deleting `host-secret` is the supported way to rotate.
//! - **Unwritable** home: no secret, so no attestation and no account
//!   fingerprint. Callers degrade; there is no unkeyed fallback.

use std::io;
use std::path::{Path, PathBuf};

use mangostudio_runtime_core::hex::hex;
use mangostudio_runtime_core::runtime_home::atomic::write_new_file;
use mangostudio_runtime_core::runtime_home::lock::{LockPolicy, with_slot_lock};
use mangostudio_runtime_core::runtime_home::mango_home_dir;
use sha2::{Digest, Sha256};

/// Secret length in bytes: the SHA-256 output size, so the HMAC key is never
/// shorter than the digest it feeds.
pub(crate) const HOST_SECRET_LEN: usize = 32;

const HOST_SECRET_FILE_NAME: &str = "host-secret";
const HOST_SECRET_LOCK_FILE_NAME: &str = "host-secret.lock";

/// `open(2)` mode of the published file on Unix. Windows restricts the DACL
/// instead; see `restrict_to_owner`.
const OWNER_ONLY_MODE: u32 = 0o600;

const HMAC_BLOCK_LEN: usize = 64;

/// Random key material for this credential home. Its `Debug` output never
/// includes the bytes.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct HostSecret([u8; HOST_SECRET_LEN]);

impl std::fmt::Debug for HostSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("HostSecret(<redacted>)")
    }
}

impl HostSecret {
    /// A fixed secret for tests that need two hosts, or two restarts, to compare.
    ///
    /// ```ignore
    /// let host_a = HostSecret::from_bytes([1; HOST_SECRET_LEN]);
    /// ```
    #[cfg(test)]
    pub(crate) fn from_bytes(bytes: [u8; HOST_SECRET_LEN]) -> Self {
        Self(bytes)
    }

    fn generate() -> io::Result<Self> {
        let mut bytes = [0u8; HOST_SECRET_LEN];
        getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
        Ok(Self(bytes))
    }

    /// Lowercase hex `HMAC-SHA256(secret, domain ++ message)`. `domain` keeps
    /// two uses of one secret from ever producing the same digest for the same
    /// message, which matters when one output is published and another is key
    /// material.
    ///
    /// ```ignore
    /// let digest = secret.hmac_hex("mangostudio/example\0", "identity");
    /// assert_eq!(digest.len(), 64);
    /// ```
    pub(crate) fn hmac_hex(&self, domain: &str, message: &str) -> String {
        let mut input = Vec::with_capacity(domain.len() + message.len());
        input.extend_from_slice(domain.as_bytes());
        input.extend_from_slice(message.as_bytes());
        hex(&hmac_sha256(&self.0, &input))
    }
}

/// Where the secret for the account owning `home` lives.
///
/// ```ignore
/// let dir = host_secret_dir(Path::new("/home/ada"));
/// ```
pub(crate) fn host_secret_dir(home: &Path) -> PathBuf {
    mango_home_dir(home)
}

/// The secret stored in `dir`, created when none usable exists.
///
/// Blocking: reads and, on first use, writes `dir`. A valid file is returned
/// without taking the lock; anything else is settled under it, so concurrent
/// callers agree on one secret.
///
/// # Errors
/// When the directory cannot be created or locked, the secret cannot be
/// generated, or the file cannot be published owner-only. The message names
/// the step and never carries key material.
///
/// ```ignore
/// let secret = load_or_create(&host_secret_dir(&home))?;
/// ```
pub(crate) fn load_or_create(dir: &Path) -> io::Result<HostSecret> {
    let path = dir.join(HOST_SECRET_FILE_NAME);
    if let Some(secret) = read_usable(&path) {
        return Ok(secret);
    }
    let settled = with_slot_lock(
        &dir.join(HOST_SECRET_LOCK_FILE_NAME),
        &LockPolicy::default(),
        || -> io::Result<HostSecret> {
            // Another caller may have published while this one waited.
            if let Some(secret) = read_usable(&path) {
                return Ok(secret);
            }
            let secret = HostSecret::generate()?;
            write_new_file(&path, &secret.0, Some(OWNER_ONLY_MODE))?;
            Ok(secret)
        },
    );
    settled.map_err(|error| io::Error::other(error.to_string()))?
}

/// The secret in `path` when it is exactly [`HOST_SECRET_LEN`] bytes and, on
/// Unix, closed to everyone but its owner. `None` for anything else, including
/// a path that cannot be read.
fn read_usable(path: &Path) -> Option<HostSecret> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() != HOST_SECRET_LEN as u64 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o077 != 0 {
            return None;
        }
    }
    let bytes = std::fs::read(path).ok()?;
    Some(HostSecret(<[u8; HOST_SECRET_LEN]>::try_from(bytes).ok()?))
}

/// RFC 2104 HMAC over SHA-256, written out because the one `hmac` consumer in
/// the workspace does not justify a dependency.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; HMAC_BLOCK_LEN];
    if key.len() > HMAC_BLOCK_LEN {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.map(|key_byte| key_byte ^ byte);
    let mut inner = Sha256::new();
    inner.update(pad(0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(pad(0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;
    use crate::test_support::scratch_dir;

    fn secret_path(dir: &Path) -> PathBuf {
        dir.join(HOST_SECRET_FILE_NAME)
    }

    fn stored_bytes(dir: &Path) -> Vec<u8> {
        std::fs::read(secret_path(dir)).expect("expected the secret file to exist")
    }

    #[test]
    fn hmac_matches_the_rfc_4231_vectors() {
        // Case 2, and case 6 for a key longer than the block size.
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_eq!(
            hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn debug_output_never_includes_the_secret() {
        let rendered = format!("{:?}", HostSecret::from_bytes([0xab; HOST_SECRET_LEN]));
        assert!(
            !rendered.contains("ab") && rendered.contains("redacted"),
            "expected a redacted rendering | received: {rendered}"
        );
    }

    #[test]
    fn the_same_secret_digests_one_message_the_same_way_every_time() {
        let secret = HostSecret::from_bytes([1; HOST_SECRET_LEN]);
        assert_eq!(
            secret.hmac_hex("domain\0", "identity"),
            secret.hmac_hex("domain\0", "identity"),
            "expected a stable digest for one secret, domain and message"
        );
    }

    #[test]
    fn different_secrets_digest_one_message_differently() {
        let host_a = HostSecret::from_bytes([1; HOST_SECRET_LEN]);
        let host_b = HostSecret::from_bytes([2; HOST_SECRET_LEN]);
        assert_ne!(
            host_a.hmac_hex("domain\0", "identity"),
            host_b.hmac_hex("domain\0", "identity"),
            "expected two hosts to disagree on the same credential home identity"
        );
    }

    #[test]
    fn domains_separate_digests_of_one_message() {
        let secret = HostSecret::from_bytes([1; HOST_SECRET_LEN]);
        assert_ne!(
            secret.hmac_hex("published\0", "identity"),
            secret.hmac_hex("key\0", "identity"),
            "expected a published digest never to equal key material"
        );
    }

    #[test]
    fn first_use_creates_a_secret_of_the_expected_length() {
        let dir = scratch_dir("host-secret-create");
        let secret = load_or_create(&dir).expect("expected a created secret");
        let stored = stored_bytes(&dir);
        assert_eq!(
            stored.len(),
            HOST_SECRET_LEN,
            "expected {HOST_SECRET_LEN} stored bytes"
        );
        assert_eq!(
            stored, secret.0,
            "expected the returned secret to be stored"
        );
        assert_ne!(stored, vec![0u8; HOST_SECRET_LEN], "expected random bytes");
    }

    #[test]
    fn the_secret_is_stable_across_restarts() {
        let dir = scratch_dir("host-secret-restart");
        let first = load_or_create(&dir).unwrap();
        let after_restart = load_or_create(&dir).unwrap();
        assert_eq!(
            first, after_restart,
            "expected the stored secret to be reused, not regenerated"
        );
    }

    #[test]
    fn two_hosts_generate_different_secrets() {
        let host_a = load_or_create(&scratch_dir("host-secret-a")).unwrap();
        let host_b = load_or_create(&scratch_dir("host-secret-b")).unwrap();
        assert_ne!(host_a, host_b, "expected independent random secrets");
    }

    #[cfg(unix)]
    #[test]
    fn the_secret_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = scratch_dir("host-secret-mode");
        load_or_create(&dir).unwrap();
        let mode = std::fs::metadata(secret_path(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "expected mode 0600 | received: {:o}",
            mode & 0o777
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_group_or_world_accessible_secret_is_replaced() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = scratch_dir("host-secret-exposed");
        let original = load_or_create(&dir).unwrap();
        std::fs::set_permissions(secret_path(&dir), std::fs::Permissions::from_mode(0o644))
            .unwrap();

        let replacement = load_or_create(&dir).unwrap();

        assert_ne!(
            original, replacement,
            "expected an exposed secret not to be kept"
        );
        let mode = std::fs::metadata(secret_path(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "expected the replacement owner-only");
    }

    #[test]
    fn a_short_secret_file_is_replaced() {
        let dir = scratch_dir("host-secret-short");
        std::fs::write(secret_path(&dir), [7u8; 5]).unwrap();
        let secret = load_or_create(&dir).unwrap();
        assert_eq!(
            stored_bytes(&dir),
            secret.0,
            "expected a {HOST_SECRET_LEN}-byte replacement for a 5-byte file"
        );
    }

    #[test]
    fn an_oversized_or_empty_secret_file_is_replaced() {
        for (label, content) in [("long", vec![9u8; 4096]), ("empty", Vec::new())] {
            let dir = scratch_dir("host-secret-size");
            std::fs::write(secret_path(&dir), &content).unwrap();
            let secret = load_or_create(&dir).unwrap();
            assert_eq!(
                stored_bytes(&dir),
                secret.0,
                "expected a {HOST_SECRET_LEN}-byte replacement for a {label} file"
            );
        }
    }

    #[test]
    fn a_directory_where_the_secret_belongs_is_an_error_not_a_panic() {
        let dir = scratch_dir("host-secret-directory");
        std::fs::create_dir(secret_path(&dir)).unwrap();
        let error = load_or_create(&dir).expect_err("expected no secret over a directory");
        assert!(
            !error.to_string().is_empty(),
            "expected a described failure | received: {error:?}"
        );
    }

    #[test]
    fn concurrent_first_starts_agree_on_one_secret() {
        const CALLERS: usize = 8;
        let dir = Arc::new(scratch_dir("host-secret-race"));
        let start = Arc::new(Barrier::new(CALLERS));
        let handles: Vec<_> = (0..CALLERS)
            .map(|_| {
                let (dir, start) = (Arc::clone(&dir), Arc::clone(&start));
                std::thread::spawn(move || {
                    start.wait();
                    load_or_create(&dir).expect("expected every caller a secret")
                })
            })
            .collect();
        let secrets: Vec<HostSecret> = handles
            .into_iter()
            .map(|handle| handle.join().expect("caller panicked"))
            .collect();

        let stored = stored_bytes(&dir);
        for secret in &secrets {
            assert_eq!(
                secret.0.as_slice(),
                stored.as_slice(),
                "expected every concurrent first start to observe the one stored secret"
            );
        }
        let leftovers: Vec<_> = std::fs::read_dir(&**dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != HOST_SECRET_FILE_NAME)
            .collect();
        assert!(
            leftovers.is_empty(),
            "expected no temp or lock file left behind | received: {leftovers:?}"
        );
    }

    #[test]
    fn the_secret_lives_in_the_credential_homes_mango_directory() {
        assert_eq!(
            host_secret_dir(Path::new("home")),
            Path::new("home").join(".mango"),
            "expected the secret beside the home's Mango state, whatever MANGO_HOME says"
        );
    }
}
