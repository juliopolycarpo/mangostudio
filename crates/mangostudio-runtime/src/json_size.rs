//! Measuring a value's compact JSON encoding without buffering it, for the
//! size budgets (frame limits, turn payload caps) that only need the length.

use serde::Serialize;

/// Counts the bytes `serde_json::to_vec(value)` would produce, streaming the
/// encoding into a counter instead of allocating it.
///
/// `serialized_len(&json!({"a": 1}))` is `Ok(7)`. Fails exactly when
/// `serde_json::to_vec` would.
pub(crate) fn serialized_len<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<usize> {
    let mut counter = ByteCount(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

struct ByteCount(usize);

impl std::io::Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::serialized_len;

    #[test]
    fn counts_the_bytes_to_vec_would_produce() {
        let value = json!({
            "id": "request-\u{e9}",
            "content": "line \"one\"\n\u{1f600}",
            "nested": [1.5, null, true],
        });
        assert_eq!(
            serialized_len(&value).unwrap(),
            serde_json::to_vec(&value).unwrap().len(),
            "expected serialized_len to equal the to_vec length for {value}"
        );
    }
}
