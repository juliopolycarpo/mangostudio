//! Lowercase hexadecimal encoding for digests, random suffixes, and ids —
//! the `Buffer.toString('hex')` spelling every wire and on-disk name uses.

use sha2::{Digest, Sha256};

/// Encodes bytes as lowercase hexadecimal, two digits per byte.
///
/// `hex(&[0x00, 0xab, 0xff])` is `"00abff"`.
pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
        encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    encoded
}

/// Returns the lowercase hex SHA-256 digest of `bytes`.
///
/// `sha256_hex(b"")` is `"e3b0c442…b855"`, 64 characters long.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::{hex, sha256_hex};

    #[test]
    fn hex_encodes_every_byte_as_two_lowercase_digits() {
        assert_eq!(hex(&[]), "");
        assert_eq!(hex(&[0x00, 0x0f, 0xab, 0xff]), "000fabff");
    }

    #[test]
    fn sha256_hex_matches_known_digests() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
