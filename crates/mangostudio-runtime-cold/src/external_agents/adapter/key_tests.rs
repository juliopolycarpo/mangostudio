//! SDK digest vectors stay in adapter-specific fixtures.
use super::{HostSecret, account_fingerprint_key, digest_key_for, identity_string};
use mango_agent_codex::account::AccountFingerprintKey;

#[test]
fn owned_host_keys_keep_the_sdk_account_digest_vectors() {
    let key = account_fingerprint_key("host-local-key".into()).unwrap();
    let sdk_key = AccountFingerprintKey::new(key.bytes()).unwrap();
    assert_eq!(
        sdk_key.fingerprint("user@example.com").as_str(),
        "bcd4e5c63495974573261faadb33d8be"
    );
    // The key text is the HMAC of the identity under the host secret (thirty-two
    // 0x01 bytes here), so the same email fingerprints differently per host.
    let identity = identity_string("linux", Some(1000), "/home/ada", 66306, 12345);
    let host_a = HostSecret::from_bytes([1; 32]);
    let key = account_fingerprint_key(digest_key_for(&host_a, &identity)).unwrap();
    let sdk_key = AccountFingerprintKey::new(key.bytes()).unwrap();
    assert_eq!(
        sdk_key.fingerprint("user@example.com").as_str(),
        "b2850343e8d956a52177077df181a97d"
    );
    let host_b = HostSecret::from_bytes([2; 32]);
    let key = account_fingerprint_key(digest_key_for(&host_b, &identity)).unwrap();
    let sdk_key = AccountFingerprintKey::new(key.bytes()).unwrap();
    assert_ne!(
        sdk_key.fingerprint("user@example.com").as_str(),
        "b2850343e8d956a52177077df181a97d",
        "expected a different host to fingerprint one account differently"
    );
}
