//! Remove JSON whitespace outside strings without rewriting any token.

/// Preserve string escapes, member order and number lexemes byte for byte.
pub fn compact_json(source: &str) -> String {
    let mut quoted = false;
    let mut escaped = false;
    source
        .chars()
        .filter(|&character| {
            if quoted {
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    quoted = false;
                }
                true
            } else if character == '"' {
                quoted = true;
                true
            } else {
                !matches!(character, ' ' | '\t' | '\r' | '\n')
            }
        })
        .collect()
}
