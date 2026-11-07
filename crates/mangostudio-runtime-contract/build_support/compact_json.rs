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

/// Write changed compact bytes only, preserving the mtime of unchanged output.
pub fn write_compact_catalog(destination: &std::path::Path, source: &str) -> std::io::Result<()> {
    let compact = compact_json(source);
    match std::fs::read(destination) {
        Ok(existing) if existing == compact.as_bytes() => return Ok(()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    std::fs::write(destination, compact)
}
