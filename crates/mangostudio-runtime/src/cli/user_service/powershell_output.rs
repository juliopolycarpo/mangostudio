//! Plain text from the stderr of a Windows PowerShell child that runs with `-EncodedCommand`.
//!
//! With `-EncodedCommand` and stderr redirected to a pipe, PowerShell (5.1 and 7) serialises its
//! error and progress streams as CLIXML instead of text, and `-OutputFormat Text` does not stop
//! it on 5.1. An operator then sees
//! `#< CLIXML <Objs ...><S S="Error">boom_x000D__x000A_</S>...` where the message belongs.
//! `$ProgressPreference = 'SilentlyContinue'` removes the progress records; the error records
//! can only be decoded. `-Command` and `-File` write plain text, but they put the script on the
//! command line or on disk, which is what `-EncodedCommand` exists to avoid.

/// Opens each CLIXML envelope on a redirected stream.
const ENVELOPE_HEADER: &str = "#< CLIXML";
const ENVELOPE_END: &str = "</Objs>";
/// Opens a string record; the attribute value is the stream it belongs to (`Error`, `Warning`).
const STRING_RECORD_OPEN: &str = "<S S=\"";
const STRING_RECORD_END: &str = "</S>";

/// Replaces every CLIXML envelope in `text` with the message text it carries.
///
/// Text outside an envelope is kept as is, in order: a native program's own stderr can sit
/// before or after one. Progress records and other serialised objects carry no message and are
/// dropped. An envelope cut short is decoded as far as it goes.
///
/// # Example
/// ```ignore
/// let plain = decode_clixml("#< CLIXML\r\n<Objs><S S=\"Error\">boom_x000D__x000A_</S></Objs>");
/// assert_eq!(plain, "boom\r\n");
/// ```
pub(super) fn decode_clixml(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(ENVELOPE_HEADER) {
        plain.push_str(&rest[..start]);
        let envelope = &rest[start + ENVELOPE_HEADER.len()..];
        let (body, after) = match envelope.find(ENVELOPE_END) {
            Some(end) => (&envelope[..end], &envelope[end + ENVELOPE_END.len()..]),
            None => (envelope, ""),
        };
        plain.push_str(&strip_ansi(&string_records(body)));
        rest = after;
    }
    plain.push_str(rest);
    plain
}

/// The unescaped content of every `<S S="...">` record in an envelope body, in order.
fn string_records(body: &str) -> String {
    let mut records = String::new();
    let mut rest = body;
    while let Some(open) = rest.find(STRING_RECORD_OPEN) {
        let after_open = &rest[open + STRING_RECORD_OPEN.len()..];
        // Skip the rest of the opening tag: the stream name, the closing quote and `>`.
        let Some(content_start) = after_open.find('>') else {
            break;
        };
        let content = &after_open[content_start + 1..];
        let (raw, next) = match content.find(STRING_RECORD_END) {
            Some(end) => (&content[..end], &content[end + STRING_RECORD_END.len()..]),
            None => (content, ""),
        };
        records.push_str(&unescape_record(raw));
        rest = next;
    }
    records
}

/// Undoes the two escapes of a CLIXML string: XML entities, then `_xHHHH_` UTF-16 code units
/// (`_x000D__x000A_` is CRLF, `_x005F_` a literal underscore, a surrogate pair is two escapes).
fn unescape_record(raw: &str) -> String {
    let xml = unescape_xml_entities(raw);
    let mut units: Vec<u16> = Vec::with_capacity(xml.len());
    let mut rest = xml.as_str();
    while let Some(character) = rest.chars().next() {
        if let Some(unit) = leading_code_unit_escape(rest) {
            units.push(unit);
            // `_x`, four hex digits and the closing `_` are all ASCII: seven bytes.
            rest = &rest[7..];
        } else {
            let mut buffer = [0u16; 2];
            units.extend_from_slice(character.encode_utf16(&mut buffer));
            rest = &rest[character.len_utf8()..];
        }
    }
    String::from_utf16_lossy(&units)
}

/// The code unit of a leading `_xHHHH_`, when `text` starts with one.
fn leading_code_unit_escape(text: &str) -> Option<u16> {
    let bytes = text.as_bytes();
    if bytes.len() < 7 || !text.starts_with("_x") || bytes[6] != b'_' {
        return None;
    }
    let digits = text.get(2..6)?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(digits, 16).ok()
}

fn unescape_xml_entities(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        text.push_str(&rest[..amp]);
        let entity_and_after = &rest[amp..];
        let decoded = entity_and_after
            .find(';')
            .and_then(|end| decode_entity(&entity_and_after[1..end]).map(|ch| (ch, end + 1)));
        match decoded {
            Some((character, length)) => {
                text.push(character);
                rest = &entity_and_after[length..];
            }
            None => {
                text.push('&');
                rest = &entity_and_after[1..];
            }
        }
    }
    text.push_str(rest);
    text
}

fn decode_entity(name: &str) -> Option<char> {
    match name {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "amp" => Some('&'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => {
            let number = name.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// Removes `ESC [ ... <letter>` colour sequences: PowerShell 7 colours its error text and the
/// serialised record carries the escapes.
fn strip_ansi(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\u{1b}' && characters.peek() == Some(&'[') {
            characters.next();
            for sequence_character in characters.by_ref() {
                if sequence_character.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            plain.push(character);
        }
    }
    plain
}

#[cfg(test)]
mod tests {
    use super::decode_clixml;

    /// Captured from Windows PowerShell 5.1 (26100, pt-BR) run as
    /// `powershell.exe -NoProfile -NonInteractive -EncodedCommand` with stdout and stderr piped,
    /// for `Write-Progress ...; throw 'boom-after-progress'`: a progress record, then the error.
    const CAPTURED_PROGRESS_THEN_THROW: &str = concat!(
        "#< CLIXML\r\n",
        "<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\">",
        "<Obj S=\"progress\" RefId=\"0\"><TN RefId=\"0\"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN>",
        "<MS><I64 N=\"SourceId\">1</I64><PR N=\"Record\"><AV>Preparando módulos para primeiro uso.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>",
        "<S S=\"Error\">boom-after-progress_x000D__x000A_</S>",
        "<S S=\"Error\">No linha:1 caractere:113_x000D__x000A_</S>",
        "<S S=\"Error\">+ ...  Write-Progress -Activity act -Completed; throw 'boom-after-progress'_x000D__x000A_</S>",
        "<S S=\"Error\">+                                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~_x000D__x000A_</S>",
        "<S S=\"Error\">    + CategoryInfo          : OperationStopped: (boom-after-progress:String) [], RuntimeException_x000D__x000A_</S>",
        "<S S=\"Error\">    + FullyQualifiedErrorId : boom-after-progress_x000D__x000A_</S>",
        "<S S=\"Error\"> _x000D__x000A_</S></Objs>",
    );

    #[test]
    fn a_captured_powershell_5_1_envelope_decodes_to_the_error_text_without_the_progress_record() {
        let plain = decode_clixml(CAPTURED_PROGRESS_THEN_THROW);
        assert_eq!(
            plain,
            "boom-after-progress\r\n\
             No linha:1 caractere:113\r\n\
             + ...  Write-Progress -Activity act -Completed; throw 'boom-after-progress'\r\n\
             +                                               ~~~~~~~~~~~~~~~~~~~~~~~~~~~\r\n    \
             + CategoryInfo          : OperationStopped: (boom-after-progress:String) [], RuntimeException\r\n    \
             + FullyQualifiedErrorId : boom-after-progress\r\n \r\n",
            "expected the message, position and category without XML | received: {plain:?}"
        );
        assert!(
            !plain.contains("CLIXML") && !plain.contains("<Objs") && !plain.contains("Preparando"),
            "expected no envelope text and no progress text | received: {plain:?}"
        );
    }

    #[test]
    fn text_outside_an_envelope_is_kept_in_order() {
        let text = "native line\r\n#< CLIXML\r\n<Objs><S S=\"Error\">boom_x000D__x000A_</S></Objs>trailing";
        assert_eq!(decode_clixml(text), "native line\r\nboom\r\ntrailing");
    }

    #[test]
    fn plain_text_without_an_envelope_is_returned_unchanged() {
        let text = "exit 3: access is denied\r\n_x0041_ & <not xml>";
        assert_eq!(decode_clixml(text), text);
    }

    #[test]
    fn a_progress_only_envelope_decodes_to_nothing() {
        let text = "#< CLIXML\r\n<Objs><Obj S=\"progress\" RefId=\"0\"><MS><PR N=\"Record\"><AV>act</AV></PR></MS></Obj></Objs>";
        assert_eq!(decode_clixml(text), "");
    }

    #[test]
    fn xml_entities_and_code_unit_escapes_are_undone_including_surrogate_pairs() {
        let text = "#< CLIXML\r\n<Objs><S S=\"Error\">a &lt;b&gt; &amp; &quot;c&quot; &apos;d&apos; &#65;&#x42; snake_x005F_case _x0041_ _xD83D__xDE00_ _xZZZZ_ _x00</S></Objs>";
        assert_eq!(
            decode_clixml(text),
            "a <b> & \"c\" 'd' AB snake_case A \u{1F600} _xZZZZ_ _x00"
        );
    }

    #[test]
    fn colour_escapes_from_powershell_7_are_removed() {
        let text = "#< CLIXML\r\n<Objs><S S=\"Error\">_x001B_[31;1mException: _x001B_[31;1mboom-throw_x001B_[0m_x000D__x000A_</S></Objs>";
        assert_eq!(decode_clixml(text), "Exception: boom-throw\r\n");
    }

    #[test]
    fn an_envelope_cut_short_decodes_as_far_as_it_goes() {
        let text = "#< CLIXML\r\n<Objs><S S=\"Error\">first_x000D__x000A_</S><S S=\"Error\">secon";
        assert_eq!(decode_clixml(text), "first\r\nsecon");
    }

    #[test]
    fn two_envelopes_decode_independently() {
        let text = "#< CLIXML\r\n<Objs><S S=\"Error\">one </S></Objs>#< CLIXML\r\n<Objs><S S=\"Error\">two</S></Objs>";
        assert_eq!(decode_clixml(text), "one two");
    }
}
