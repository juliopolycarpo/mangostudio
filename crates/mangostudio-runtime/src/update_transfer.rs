//! Bounded, disk-backed receipt of one runtime binary before slot publication.
//!
//! A transfer owns its stage file. Dropping an incomplete or mismatched
//! transfer removes that file; a verified transfer keeps the stage until the
//! slot publisher has linked its bytes into an immutable version directory.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use mango_protocol::error::RemoteError;
use mangostudio_runtime_contract::errors::RUNTIME_UPDATE_REFUSED;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::slot_publish::validate_slot_version;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

pub(crate) const MAX_UPDATE_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_CHUNK_BYTES: usize = 32 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BeginParams {
    pub version: String,
    pub digest: String,
    pub total_bytes: f64,
    pub source_sha: Option<String>,
}

pub(crate) struct ValidatedBegin {
    pub version: String,
    pub digest: String,
    pub total_bytes: u64,
    pub source_sha: Option<String>,
}

impl TryFrom<BeginParams> for ValidatedBegin {
    type Error = RemoteError;

    fn try_from(params: BeginParams) -> Result<Self, Self::Error> {
        if validate_slot_version(&params.version).is_err() {
            return Err(refusal(
                "invalid_version",
                format!(
                    "Runtime update version {:?} is not a safe slot directory name.",
                    params.version
                ),
            ));
        }
        if params.digest.len() != 71
            || !params.digest.starts_with("sha256:")
            || !params.digest[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(refusal(
                "invalid_digest",
                format!(
                    "Runtime update digest {:?} must be a lowercase sha256 digest.",
                    params.digest
                ),
            ));
        }
        let total = params.total_bytes;
        if !total.is_finite()
            || total.fract() != 0.0
            || !(1.0..=MAX_UPDATE_BYTES as f64).contains(&total)
        {
            return Err(refusal(
                "invalid_size",
                format!(
                    "Runtime update size {total} must be an integer between 1 and {MAX_UPDATE_BYTES} bytes."
                ),
            ));
        }
        if let Some(source_sha) = &params.source_sha
            && (!(7..=40).contains(&source_sha.len())
                || !source_sha
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        {
            return Err(refusal(
                "invalid_source_sha",
                format!(
                    "Runtime update source commit {:?} must be a lowercase git commit sha.",
                    source_sha
                ),
            ));
        }
        Ok(Self {
            version: params.version,
            digest: params.digest,
            total_bytes: total as u64,
            source_sha: params.source_sha,
        })
    }
}

fn digest_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn refusal(reason: &str, message: String) -> RemoteError {
    RemoteError::new(RUNTIME_UPDATE_REFUSED, message)
        .with_detail("kind", "runtime_update_refused")
        .with_detail("reason", reason)
}

#[derive(Debug)]
pub(crate) enum TransferError {
    Refused(RemoteError),
    Io(io::Error),
}

impl From<io::Error> for TransferError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub(crate) struct StagedTransfer {
    pub begin: ValidatedBegin,
    stage: PathBuf,
    file: Option<File>,
    hash: Sha256,
    next_seq: u64,
    received: u64,
}

impl StagedTransfer {
    /// Starts a fresh stage beneath `slot_dir`; the caller owns cross-process
    /// slot locking around the whole transfer.
    pub fn begin(slot_dir: &Path, id: &str, begin: ValidatedBegin) -> io::Result<Self> {
        std::fs::create_dir_all(slot_dir)?;
        let stage = slot_dir.join(format!(".mangostudio-runtime.incoming-{id}"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o700);
        let file = options.open(&stage)?;
        Ok(Self {
            begin,
            stage,
            file: Some(file),
            hash: Sha256::new(),
            next_seq: 0,
            received: 0,
        })
    }

    /// Writes the next bounded chunk and returns the total confirmed bytes.
    pub fn chunk(&mut self, seq: u64, bytes: &[u8]) -> Result<u64, TransferError> {
        if seq != self.next_seq {
            return Err(TransferError::Refused(refusal(
                "sequence_mismatch",
                format!(
                    "Runtime update expected chunk {}, received {seq}.",
                    self.next_seq
                ),
            )));
        }
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES {
            return Err(TransferError::Refused(refusal(
                "invalid_chunk_size",
                format!(
                    "Runtime update chunk size {} must be between 1 and {MAX_CHUNK_BYTES} bytes.",
                    bytes.len()
                ),
            )));
        }
        if self.received + bytes.len() as u64 > self.begin.total_bytes {
            return Err(TransferError::Refused(refusal(
                "total_exceeded",
                format!(
                    "Runtime update chunk would exceed the declared {} bytes.",
                    self.begin.total_bytes
                ),
            )));
        }
        self.file
            .as_mut()
            .expect("stage is open until verification")
            .write_all(bytes)?;
        self.hash.update(bytes);
        self.received += bytes.len() as u64;
        self.next_seq += 1;
        Ok(self.received)
    }

    /// Flushes and verifies the exact declared length and SHA-256 digest.
    pub fn verify(mut self) -> Result<VerifiedStage, TransferError> {
        if self.received != self.begin.total_bytes {
            return Err(TransferError::Refused(refusal(
                "incomplete",
                format!(
                    "Runtime update received {} of {} bytes.",
                    self.received, self.begin.total_bytes
                ),
            )));
        }
        self.file
            .as_ref()
            .expect("stage is open until verification")
            .sync_all()?;
        drop(self.file.take());
        let actual = format!("sha256:{}", digest_hex(&self.hash.clone().finalize()));
        if actual != self.begin.digest {
            return Err(TransferError::Refused(refusal(
                "digest_mismatch",
                format!(
                    "Runtime update digest mismatch: expected {}, got {actual}.",
                    self.begin.digest
                ),
            )));
        }
        Ok(VerifiedStage { transfer: self })
    }
}

impl Drop for StagedTransfer {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.stage);
    }
}

pub(crate) struct VerifiedStage {
    transfer: StagedTransfer,
}

impl VerifiedStage {
    pub fn path(&self) -> &Path {
        &self.transfer.stage
    }

    pub fn begin(&self) -> &ValidatedBegin {
        &self.transfer.begin
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn begin(total_bytes: f64, digest: &str) -> ValidatedBegin {
        ValidatedBegin::try_from(BeginParams {
            version: "0.2.0-canary.4".into(),
            digest: digest.into(),
            total_bytes,
            source_sha: None,
        })
        .expect("valid fixture")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mango-update-transfer-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn refuses_unsafe_versions_sizes_and_digests_before_creating_files() {
        for version in ["../outside", ".hidden", "a/b", ""] {
            let error = ValidatedBegin::try_from(BeginParams {
                version: version.into(),
                digest: format!("sha256:{}", "a".repeat(64)),
                total_bytes: 1.0,
                source_sha: None,
            })
            .err()
            .expect("unsafe version refused");
            assert_eq!(error.details.unwrap()["reason"], "invalid_version");
        }
        for total_bytes in [0.0, f64::INFINITY, 1.5, MAX_UPDATE_BYTES as f64 + 1.0] {
            let error = ValidatedBegin::try_from(BeginParams {
                version: "1.0".into(),
                digest: format!("sha256:{}", "a".repeat(64)),
                total_bytes,
                source_sha: None,
            })
            .err()
            .expect("unsafe size refused");
            assert_eq!(error.details.unwrap()["reason"], "invalid_size");
        }
        let error = ValidatedBegin::try_from(BeginParams {
            version: "1.0".into(),
            digest: "sha256:DEADBEEF".into(),
            total_bytes: 1.0,
            source_sha: None,
        })
        .err()
        .expect("wrong digest refused");
        assert_eq!(error.details.unwrap()["reason"], "invalid_digest");
    }

    #[test]
    fn failed_or_incomplete_transfer_removes_stage_and_preserves_slot() {
        let slot = scratch("bad-digest");
        std::fs::create_dir_all(&slot).unwrap();
        std::fs::write(slot.join("current"), "old").unwrap();
        let mut transfer = StagedTransfer::begin(
            &slot,
            "one",
            begin(3.0, &format!("sha256:{}", "0".repeat(64))),
        )
        .unwrap();
        let stage = transfer.stage.clone();
        assert_eq!(transfer.chunk(0, b"abc").unwrap(), 3);
        assert!(matches!(transfer.verify(), Err(TransferError::Refused(_))));
        assert!(!stage.exists());
        assert_eq!(
            std::fs::read_to_string(slot.join("current")).unwrap(),
            "old"
        );

        let mut transfer = StagedTransfer::begin(
            &slot,
            "two",
            begin(3.0, &format!("sha256:{}", "0".repeat(64))),
        )
        .unwrap();
        assert!(matches!(
            transfer.chunk(1, b"a"),
            Err(TransferError::Refused(_))
        ));
        assert!(matches!(
            transfer.chunk(0, b"abcd"),
            Err(TransferError::Refused(_))
        ));
        assert!(matches!(transfer.verify(), Err(TransferError::Refused(_))));
        assert_eq!(
            std::fs::read_to_string(slot.join("current")).unwrap(),
            "old"
        );
        std::fs::remove_dir_all(slot).unwrap();
    }

    #[test]
    fn verified_transfer_keeps_bytes_until_publication_scope_ends() {
        let slot = scratch("verified");
        let digest = format!("sha256:{}", digest_hex(&Sha256::digest(b"abc")));
        let mut transfer = StagedTransfer::begin(&slot, "three", begin(3.0, &digest)).unwrap();
        assert_eq!(transfer.chunk(0, b"a").unwrap(), 1);
        assert_eq!(transfer.chunk(1, b"bc").unwrap(), 3);
        let verified = transfer.verify().unwrap();
        let path = verified.path().to_owned();
        assert_eq!(std::fs::read(&path).unwrap(), b"abc");
        assert_eq!(verified.begin().version, "0.2.0-canary.4");
        drop(verified);
        assert!(!path.exists());
        std::fs::remove_dir_all(slot).unwrap();
    }
}
