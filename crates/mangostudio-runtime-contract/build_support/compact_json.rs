//! Remove insignificant JSON whitespace without rewriting any token.

/// Preserve string escapes, member order and number lexemes byte for byte.
/// For example, `[ 1.0 ]` becomes `[1.0]`, and `[1 0]` remains invalid.
pub fn compact_json(source: &str) -> String {
    const STRUCTURAL: [char; 6] = ['[', ']', '{', '}', ',', ':'];
    let mut compact = String::new();
    let mut quoted = false;
    let mut escaped = false;
    let mut pending_whitespace = false;

    for character in source.chars() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
        } else if matches!(character, ' ' | '\t' | '\r' | '\n') {
            pending_whitespace = true;
            continue;
        } else {
            // Preserve token boundaries even when the source contains invalid JSON.
            if pending_whitespace
                && !compact.is_empty()
                && !compact.ends_with(STRUCTURAL)
                && !STRUCTURAL.contains(&character)
            {
                compact.push(' ');
            }
            pending_whitespace = false;
            quoted = character == '"';
        }
        compact.push(character);
    }
    compact
}

/// Write changed compact bytes only, preserving the mtime of unchanged output.
/// For example, writing `[ 1 ]` to `catalog.compact.json` stores `[1]`.
pub fn write_compact_catalog(destination: &std::path::Path, source: &str) -> std::io::Result<()> {
    let compact = compact_json(source);
    match std::fs::read(destination) {
        Ok(existing) if existing == compact.as_bytes() => return Ok(()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    std::fs::write(destination, compact)
}
