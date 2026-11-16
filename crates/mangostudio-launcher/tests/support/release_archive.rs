//! Builders for the release assets the launcher tests serve: a platform
//! archive in the format the launcher unpacks on this host (tar.gz on Unix,
//! zip on Windows) and the `SHA256SUMS` manifest that lists it.

use sha2::{Digest, Sha256};
use std::fmt::Write as _;

/// An archive with the flat release layout: the hub binary, whose content is
/// `binary_body`, and a README. On Unix the binary is mode 0755 so a test can
/// make the launcher exec it when `binary_body` is a shell script.
#[cfg(unix)]
pub fn archive_with_binary(binary_body: &str) -> Vec<u8> {
    use flate2::Compression;
    use flate2::write::GzEncoder;

    let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    for (name, content, mode) in [
        ("mangostudio", binary_body, 0o755),
        ("README.md", "release readme\n", 0o644),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(mode);
        header.set_cksum();
        builder
            .append_data(&mut header, name, content.as_bytes())
            .expect("expected the fixture entry to be appended to the tar archive");
    }
    builder
        .into_inner()
        .expect("expected the tar archive to finish")
        .finish()
        .expect("expected the gzip stream to finish")
}

#[cfg(windows)]
pub fn archive_with_binary(binary_body: &str) -> Vec<u8> {
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};

    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, content) in [
        ("mangostudio.exe", binary_body),
        ("README.md", "release readme\n"),
    ] {
        writer
            .start_file(name, SimpleFileOptions::default())
            .and_then(|()| writer.write_all(content.as_bytes()).map_err(Into::into))
            .expect("expected the fixture entry to be added to the zip archive");
    }
    writer
        .finish()
        .expect("expected the zip archive to finish")
        .into_inner()
}

pub fn sha256_hex_of(bytes: &[u8]) -> String {
    let mut hex = String::new();
    for byte in Sha256::digest(bytes) {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// A `sha256sum`-style manifest listing `asset` with the digest of `bytes`,
/// beside an unrelated entry so a lookup has to pick the right line.
pub fn manifest_listing(asset: &str, bytes: &[u8]) -> String {
    format!(
        "{}  other-asset.bin\n{}  {asset}\n",
        "0".repeat(64),
        sha256_hex_of(bytes)
    )
}
