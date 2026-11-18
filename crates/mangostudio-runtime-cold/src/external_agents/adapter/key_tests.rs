//! SDK digest vectors stay in adapter-specific fixtures.
use super::{account_fingerprint_key, digest_key_for, identity_string};
use mango_agent_codex::account::AccountFingerprintKey;

#[test]
fn owned_host_keys_keep_the_typescript_account_digest_vectors() {
    let key = account_fingerprint_key("host-local-key".into()).unwrap();
    let sdk_key = AccountFingerprintKey::new(key.bytes()).unwrap();
    assert_eq!(
        sdk_key.fingerprint("user@example.com").as_str(),
        "bcd4e5c63495974573261faadb33d8be"
    );
    let identity = identity_string("linux", Some(1000), "/home/ada", 66306, 12345);
    let key = account_fingerprint_key(digest_key_for(&identity)).unwrap();
    let sdk_key = AccountFingerprintKey::new(key.bytes()).unwrap();
    assert_eq!(
        sdk_key.fingerprint("user@example.com").as_str(),
        "5804f50595bc9d505930fc1468620036"
    );
}
