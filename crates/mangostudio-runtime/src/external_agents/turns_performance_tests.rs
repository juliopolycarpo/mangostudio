//! Controls for the request digest and ownership transfer.
use super::*;

/// Named serialization fake: fails after emitting one sequence element.
struct PartiallySerialized;
impl serde::Serialize for PartiallySerialized {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{Error as _, SerializeSeq as _};
        let mut sequence = serializer.serialize_seq(Some(2))?;
        sequence.serialize_element("already emitted bytes")?;
        Err(S::Error::custom(
            "intentional partial serialization failure",
        ))
    }
}

#[test]
fn failed_partial_serialization_keeps_the_original_empty_byte_digest() {
    assert!(serde_json::to_vec(&PartiallySerialized).is_err());
    let empty: [u8; 32] = Sha256::digest([]).into();
    assert_eq!(fingerprint(&PartiallySerialized), empty);
}

#[test]
fn fingerprint_preserves_escaping_unicode_and_buffer_boundary_shapes() {
    for input in [
        "\"\\\n\r\t\u{00e9}\u{1f9ea}".to_owned(),
        "x".repeat(4095),
        "\0".repeat(4097),
    ] {
        let params = serde_json::json!({"input": input, "optional": null});
        let expected: [u8; 32] = Sha256::digest(serde_json::to_vec(&params).unwrap()).into();
        assert_eq!(fingerprint(&params), expected);
    }
}

#[test]
fn digest_is_the_original_complete_json_digest_for_every_fixture() {
    for case in benchmarks::CASES {
        let params = benchmarks::fixture(case);
        let expected: [u8; 32] = Sha256::digest(serde_json::to_vec(&params).unwrap()).into();
        assert_eq!(fingerprint(&params), expected, "fixture {case}");
    }
}

#[test]
fn request_preparation_preserves_ids_configuration_input_and_decoded_attachment_metadata() {
    let mut params = benchmarks::fixture("combined");
    let expected = params.clone();
    let attachments = decoded_attachments(params.attachments.as_deref().unwrap()).unwrap();
    let pointers: Vec<_> = attachments.iter().map(|item| item.bytes.as_ptr()).collect();
    let request = turn_request(&mut params, attachments);
    assert_eq!(request.input, expected.input);
    assert_eq!(request.turn_id, expected.client_message_id);
    assert_eq!(request.configuration, &expected.configuration);
    for ((attachment, encoded), pointer) in request
        .attachments
        .iter()
        .zip(expected.attachments.as_ref().unwrap())
        .zip(pointers)
    {
        assert_eq!(attachment.id, encoded.id);
        assert_eq!(attachment.name, encoded.original_name);
        assert_eq!(attachment.mime_type, encoded.mime_type);
        assert_eq!(attachment.kind, encoded.kind);
        assert_eq!(attachment.bytes.len() as u64, encoded.size_bytes);
        assert_eq!(attachment.bytes.as_ptr(), pointer);
    }
}
