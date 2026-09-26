//! Library content hashes, byte-compatible with
//! `apps/shared/src/library/hash.ts` and the whitespace digests in
//! `apps/shared/src/library/machine/instance-reader.ts`.
//!
//! Three hash shapes live here, each in its own domain so no two can
//! collide: a file's bytes (`mangostudio/library/file\0`), a directory's
//! length-prefixed manifest (`mangostudio/library/dir/v2\0`, whose version the
//! capability manifest advertises as `directoryHashDomain`), and the
//! whitespace-insensitive digest the hub uses to tell a formatting-only
//! divergence from a real one.

use sha2::{Digest, Sha256};

use super::collation::locale_compare;
use super::js::{cmp_utf16, strip_js_whitespace, text_decoder_decode, utf16_len};

const FILE_HASH_DOMAIN: &[u8] = b"mangostudio/library/file\0";
/// `DIRECTORY_HASH_DOMAIN`. Versioned: v2 is the length-prefixed manifest.
pub(crate) const DIRECTORY_HASH_DOMAIN: &[u8] = b"mangostudio/library/dir/v2\0";

/// The version the capability manifest advertises as `directoryHashDomain`,
/// derived from [`DIRECTORY_HASH_DOMAIN`] at compile time so a v3 bump cannot
/// forget the advertisement (`directoryHashDomainVersion` in
/// `apps/shared/src/library/hash.ts` makes the same derivation).
///
/// Usage: `manifest.directory_hash_domain = Some(DIRECTORY_HASH_DOMAIN_VERSION)`.
pub(crate) const DIRECTORY_HASH_DOMAIN_VERSION: u32 =
    directory_hash_domain_version(DIRECTORY_HASH_DOMAIN);

/// The largest version the capability schema accepts
/// (`MAX_DIRECTORY_HASH_DOMAIN_VERSION` in `apps/shared/src/library/hash.ts`).
const MAX_DIRECTORY_HASH_DOMAIN_VERSION: u32 = 255;

/// Reads `<n>` out of a domain shaped `.../v<n>\0`; any other shape, or a
/// version the capability schema cannot carry, fails the build.
const fn directory_hash_domain_version(domain: &[u8]) -> u32 {
    assert!(
        domain.len() >= 4 && domain[domain.len() - 1] == 0,
        "the directory hash domain must end in /v<n>\\0"
    );
    let mut start = domain.len() - 1;
    while start > 0 && domain[start - 1].is_ascii_digit() {
        start -= 1;
    }
    assert!(
        start >= 2 && start < domain.len() - 1,
        "the directory hash domain must end in /v<n>\\0"
    );
    assert!(
        domain[start - 1] == b'v' && domain[start - 2] == b'/',
        "the directory hash domain must end in /v<n>\\0"
    );
    let mut version: u32 = 0;
    let mut index = start;
    while index < domain.len() - 1 {
        assert!(
            version <= MAX_DIRECTORY_HASH_DOMAIN_VERSION,
            "the directory hash domain version exceeds what the capability schema can advertise"
        );
        version = version * 10 + (domain[index] - b'0') as u32;
        index += 1;
    }
    assert!(
        version >= 1 && version <= MAX_DIRECTORY_HASH_DOMAIN_VERSION,
        "the directory hash domain version must be 1..=255 so the capability schema can advertise it"
    );
    version
}
const WHITESPACE_HASH_DOMAIN: &[u8] = b"mangostudio/library/whitespace\0";

/// Why a directory cannot be hashed, as `LibraryInvalidReason` spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ManifestViolation {
    /// A relative path that could climb out of the root.
    PathEscape,
    /// A relative path carrying `\n` or `\0`, which could forge a manifest line.
    UnsafeName,
}

fn sha256_hex(domain: &[u8], bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(bytes);
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// `hashLibraryFile`'s digest: SHA-256 over the file domain and the bytes.
#[must_use]
pub(crate) fn hash_file_bytes(bytes: &[u8]) -> String {
    sha256_hex(FILE_HASH_DOMAIN, bytes)
}

/// `relativePathViolation` for POSIX-style relative paths. The Windows drive
/// check applies only when `win32` is set, as `pathStyle` decides it in
/// TypeScript; backslashes are separators only then too.
#[must_use]
pub(crate) fn relative_path_violation(path: &str, win32: bool) -> Option<ManifestViolation> {
    if path.is_empty() || path.starts_with('/') {
        return Some(ManifestViolation::PathEscape);
    }
    let bytes = path.as_bytes();
    if win32
        && bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
    {
        return Some(ManifestViolation::PathEscape);
    }
    if path.contains('\n') || path.contains('\0') {
        return Some(ManifestViolation::UnsafeName);
    }
    let normalized;
    let segments: &str = if win32 {
        normalized = path.replace('\\', "/");
        &normalized
    } else {
        path
    };
    let escapes = segments
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..");
    escapes.then_some(ManifestViolation::PathEscape)
}

/// Builds a directory hash from `(relative_path, file_digest)` pairs,
/// sorting them by UTF-16 code units the way `comparePaths` does. Each line
/// is `<utf16 length>:<path><64 hex>`, concatenated without separators.
#[derive(Debug, Default)]
pub(crate) struct DirectoryManifest {
    lines: Vec<(String, String)>,
    size_bytes: u64,
}

impl DirectoryManifest {
    /// Adds one leaf's relative path, file digest, and byte length.
    pub(crate) fn push(&mut self, relative_path: &str, file_digest: String, len: u64) {
        self.lines.push((relative_path.to_string(), file_digest));
        self.size_bytes += len;
    }

    /// The final `(content_hash, size_bytes)`.
    #[must_use]
    pub(crate) fn finish(mut self) -> (String, u64) {
        self.lines
            .sort_by(|(left, _), (right, _)| cmp_utf16(left, right));
        let mut manifest = String::new();
        for (path, digest) in &self.lines {
            manifest.push_str(&utf16_len(path).to_string());
            manifest.push(':');
            manifest.push_str(path);
            manifest.push_str(digest);
        }
        (
            sha256_hex(DIRECTORY_HASH_DOMAIN, manifest.as_bytes()),
            self.size_bytes,
        )
    }
}

/// `whitespaceDigest`: SHA-256 of the decoded text with every ECMAScript
/// whitespace character removed.
#[must_use]
pub(crate) fn whitespace_digest(bytes: &[u8]) -> String {
    let text = strip_js_whitespace(&text_decoder_decode(bytes));
    sha256_hex(b"", text.as_bytes())
}

/// `combineWhitespaceDigests`: order-independent, so entries are sorted by
/// `localeCompare` on their paths first. Duplicate entries are hashed as
/// given — the TypeScript hash pass can record one file twice when two leaf
/// names resolve to it, and that is part of the digest.
#[must_use]
pub(crate) fn combine_whitespace_digests(entries: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = entries.iter().collect();
    // Stable, like `Array.prototype.sort`, so equal paths keep read order.
    sorted.sort_by(|(left, _), (right, _)| locale_compare(left, right));
    let mut hasher = Sha256::new();
    hasher.update(WHITESPACE_HASH_DOMAIN);
    for (path, digest) in sorted {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(digest.as_bytes());
        hasher.update(b"\n");
    }
    hex(&hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_advertised_directory_domain_version_is_read_from_the_domain_itself() {
        assert_eq!(DIRECTORY_HASH_DOMAIN_VERSION, 2);
        assert_eq!(
            directory_hash_domain_version(b"mangostudio/library/dir/v3\0"),
            3
        );
        assert_eq!(
            directory_hash_domain_version(b"mangostudio/library/dir/v255\0"),
            255
        );
    }

    #[test]
    #[should_panic(expected = "must end in /v<n>")]
    fn a_directory_domain_without_a_version_suffix_is_refused() {
        let _ = directory_hash_domain_version(b"mangostudio/library/dir\0");
    }

    #[test]
    #[should_panic(expected = "1..=255")]
    fn a_directory_domain_version_the_schema_cannot_carry_is_refused() {
        let _ = directory_hash_domain_version(b"mangostudio/library/dir/v256\0");
    }

    #[test]
    fn file_and_directory_domains_never_collide_on_a_forged_manifest() {
        let digest = hash_file_bytes(b"x");
        let mut manifest = DirectoryManifest::default();
        manifest.push("a", digest.clone(), 1);
        let (directory, _) = manifest.finish();
        let forged = format!("1:a{digest}");
        assert_ne!(
            directory,
            hash_file_bytes(forged.as_bytes()),
            "a file spelling a one-entry manifest must not hash like the directory it describes"
        );
    }

    #[test]
    fn relative_path_violations_match_hash_ts() {
        assert_eq!(
            relative_path_violation("a\nb", false),
            Some(ManifestViolation::UnsafeName)
        );
        assert_eq!(
            relative_path_violation("a/../b", false),
            Some(ManifestViolation::PathEscape)
        );
        assert_eq!(relative_path_violation("a\\..\\b", false), None);
        assert_eq!(
            relative_path_violation("a\\..\\b", true),
            Some(ManifestViolation::PathEscape)
        );
        assert_eq!(
            relative_path_violation("C:/x", true),
            Some(ManifestViolation::PathEscape)
        );
        for escaping in ["a/./b", "a//b", ".", "a/.."] {
            assert_eq!(
                relative_path_violation(escaping, false),
                Some(ManifestViolation::PathEscape),
                "expected {escaping:?} to be refused as a path escape"
            );
        }
        // Only `^[A-Za-z]:[\\/]` is a drive prefix (the regex hash.ts uses):
        // names that merely resemble one stay hashable.
        for name in ["ab\\c", "C:x", "a:b", "1:/x"] {
            assert_eq!(
                relative_path_violation(name, true),
                None,
                "expected {name:?} to be a safe win32 name | received a violation"
            );
        }
        assert_eq!(
            relative_path_violation("C:\\x", true),
            Some(ManifestViolation::PathEscape)
        );
        assert_eq!(
            relative_path_violation("", false),
            Some(ManifestViolation::PathEscape)
        );
    }
}
