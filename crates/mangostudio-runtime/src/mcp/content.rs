//! Byte-exact port of `@mangostudio/shared/mcp/content-mapping` plus the descriptor mappings in
//! the TypeScript host's `client-factory.ts`.
//!
//! Everything here works on JSON as the server sent it (after the SDK accepted the result), so
//! the capping, markers, and field presence match the TypeScript host exactly: a server that
//! dumps a megabyte of text must not put a megabyte on the runtime wire.

use serde_json::{Map, Value, json};

/// Cap on the flattened result and on each text payload (`MCP_RESULT_MAX_BYTES`).
pub(crate) const MCP_RESULT_MAX_BYTES: usize = 64 * 1024;
/// Appended when the flattened text was cut (`MCP_RESULT_TRUNCATION_MARKER`).
pub(crate) const MCP_RESULT_TRUNCATION_MARKER: &str = "\n\n[MCP tool result truncated at 64 KiB]";
const REPLACEMENT: char = '\u{FFFD}';

/// Cuts `text` to at most `max` UTF-8 bytes exactly as the TypeScript host does: decode the cut
/// bytes lossily, then strip every trailing U+FFFD (including a genuine one before the cut).
fn truncate_utf8(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    String::from_utf8_lossy(&text.as_bytes()[..max])
        .trim_end_matches(REPLACEMENT)
        .to_owned()
}

/// Caps flattened text, appending the marker when it had to cut (`capMcpResultText`).
///
/// # Example
/// ```ignore
/// assert_eq!(cap_result_text("short"), "short");
/// ```
pub(crate) fn cap_result_text(text: &str) -> String {
    if text.len() <= MCP_RESULT_MAX_BYTES {
        return text.to_owned();
    }
    format!(
        "{}{MCP_RESULT_TRUNCATION_MARKER}",
        truncate_utf8(text, MCP_RESULT_MAX_BYTES)
    )
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn unknown(block_type: &str, mime_type: Option<&str>) -> Value {
    let mut block = json!({ "type": "unknown", "blockType": block_type });
    if let Some(mime) = mime_type {
        block["mimeType"] = json!(mime);
    }
    block
}

/// Converts raw content blocks into the `RuntimeMcpContentBlock` union (`normalizeMcpContent`).
///
/// # Example
/// ```ignore
/// let blocks = normalize_content(&[json!({"type": "text", "text": "hi"})]);
/// ```
pub(crate) fn normalize_content(raw: &[Value]) -> Vec<Value> {
    raw.iter().map(normalize_block).collect()
}

fn normalize_block(block: &Value) -> Value {
    let block_type = string(block, "type").unwrap_or_default();
    let top_mime = string(block, "mimeType");
    match block_type {
        "text" => {
            let Some(text) = string(block, "text") else {
                return unknown(block_type, top_mime);
            };
            if text.len() > MCP_RESULT_MAX_BYTES {
                return json!({
                    "type": "text",
                    "text": truncate_utf8(text, MCP_RESULT_MAX_BYTES),
                    "truncated": true,
                });
            }
            json!({ "type": "text", "text": text })
        }
        "image" | "audio" => {
            let (Some(data), Some(mime)) = (string(block, "data"), top_mime) else {
                return unknown(block_type, top_mime);
            };
            if data.len() > MCP_RESULT_MAX_BYTES {
                return unknown(block_type, Some(mime));
            }
            json!({ "type": block_type, "data": data, "mimeType": mime })
        }
        "resource" => normalize_resource(block).unwrap_or_else(|| unknown(block_type, top_mime)),
        _ => unknown(block_type, top_mime),
    }
}

fn normalize_resource(block: &Value) -> Option<Value> {
    let resource = block.get("resource").filter(|value| value.is_object())?;
    let uri = string(resource, "uri")?;
    let mime = string(resource, "mimeType");
    let text = string(resource, "text");
    let blob = string(resource, "blob");
    let keep_blob = blob.filter(|blob| blob.len() <= MCP_RESULT_MAX_BYTES);
    if blob.is_some() && keep_blob.is_none() && text.is_none() {
        return Some(unknown("resource", mime));
    }
    let mut out = Map::new();
    out.insert("type".into(), json!("resource"));
    out.insert("uri".into(), json!(uri));
    if let Some(mime) = mime {
        out.insert("mimeType".into(), json!(mime));
    }
    if let Some(text) = text {
        if text.len() > MCP_RESULT_MAX_BYTES {
            out.insert(
                "text".into(),
                json!(truncate_utf8(text, MCP_RESULT_MAX_BYTES)),
            );
            out.insert("textTruncated".into(), json!(true));
        } else {
            out.insert("text".into(), json!(text));
        }
    }
    if let Some(blob) = keep_blob {
        out.insert("blob".into(), json!(blob));
    }
    Some(Value::Object(out))
}

/// Flattens normalized blocks into the capped text the model receives (`flattenMcpContent`).
///
/// # Example
/// ```ignore
/// let text = flatten_content(&normalize_content(&raw));
/// ```
pub(crate) fn flatten_content(blocks: &[Value]) -> String {
    let joined = blocks
        .iter()
        .map(flat_text)
        .collect::<Vec<_>>()
        .join("\n\n");
    let block_was_capped = blocks.iter().any(|block| {
        block.get("truncated") == Some(&json!(true))
            || block.get("textTruncated") == Some(&json!(true))
    });
    if block_was_capped && !joined.ends_with(MCP_RESULT_TRUNCATION_MARKER) {
        return format!(
            "{}{MCP_RESULT_TRUNCATION_MARKER}",
            truncate_utf8(&joined, MCP_RESULT_MAX_BYTES)
        );
    }
    cap_result_text(&joined)
}

fn flat_text(block: &Value) -> String {
    let mime_suffix = || {
        string(block, "mimeType")
            .map(|mime| format!(", {mime}"))
            .unwrap_or_default()
    };
    match string(block, "type").unwrap_or_default() {
        "text" => string(block, "text").unwrap_or_default().to_owned(),
        kind @ ("image" | "audio") => format!(
            "[{kind} content, {}]",
            string(block, "mimeType").unwrap_or_default()
        ),
        "resource" => match string(block, "text") {
            Some(text) => text.to_owned(),
            None => format!(
                "[binary resource {}{}]",
                string(block, "uri").unwrap_or_default(),
                mime_suffix()
            ),
        },
        _ => format!(
            "[unsupported {} content{}]",
            string(block, "blockType").unwrap_or_default(),
            mime_suffix()
        ),
    }
}

/// Maps a `tools/call` result (`mapCallResult`).
pub(crate) fn call_result(result: &Value) -> Value {
    let raw = result
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let content = normalize_content(&raw);
    json!({
        "contentText": flatten_content(&content),
        "isError": result.get("isError") == Some(&json!(true)),
        "rawContentKinds": raw.iter().map(|block| block.get("type").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(),
        "content": content,
    })
}

fn copy_string(from: &Value, key: &str, to: &mut Map<String, Value>, as_key: &str) {
    if let Some(value) = string(from, key) {
        to.insert(as_key.into(), json!(value));
    }
}

/// Maps one `resources/list` entry onto `McpResourceDescriptor`.
pub(crate) fn resource_descriptor(resource: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "uri".into(),
        resource.get("uri").cloned().unwrap_or(Value::Null),
    );
    let name = string(resource, "title").or_else(|| string(resource, "name"));
    out.insert("name".into(), json!(name.unwrap_or_default()));
    copy_string(resource, "description", &mut out, "description");
    copy_string(resource, "mimeType", &mut out, "mimeType");
    if let Some(size) = resource.get("size").filter(|size| size.is_number()) {
        out.insert("sizeBytes".into(), size.clone());
    }
    Value::Object(out)
}

/// Maps one `resources/read` content entry onto `RuntimeMcpResourceContents`.
pub(crate) fn resource_contents(entry: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "uri".into(),
        entry.get("uri").cloned().unwrap_or(Value::Null),
    );
    copy_string(entry, "mimeType", &mut out, "mimeType");
    copy_string(entry, "text", &mut out, "text");
    copy_string(entry, "blob", &mut out, "blob");
    Value::Object(out)
}

/// Maps one `prompts/list` entry onto `McpPromptDescriptor`.
pub(crate) fn prompt_descriptor(prompt: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "name".into(),
        prompt.get("name").cloned().unwrap_or(Value::Null),
    );
    copy_string(prompt, "description", &mut out, "description");
    let arguments = prompt
        .get("arguments")
        .and_then(Value::as_array)
        .map(|arguments| {
            arguments
                .iter()
                .map(|argument| {
                    let mut entry = Map::new();
                    entry.insert(
                        "name".into(),
                        argument.get("name").cloned().unwrap_or(Value::Null),
                    );
                    copy_string(argument, "description", &mut entry, "description");
                    if let Some(required) = argument.get("required").filter(|v| v.is_boolean()) {
                        entry.insert("required".into(), required.clone());
                    }
                    Value::Object(entry)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    out.insert("arguments".into(), json!(arguments));
    Value::Object(out)
}

/// Maps a `prompts/get` result onto `RuntimeMcpPromptResult`.
pub(crate) fn prompt_result(result: &Value) -> Value {
    let mut out = Map::new();
    copy_string(result, "description", &mut out, "description");
    let messages = result
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .map(|message| {
                    let content = message.get("content").cloned().unwrap_or(Value::Null);
                    json!({
                        "role": message.get("role").cloned().unwrap_or(Value::Null),
                        "text": flatten_content(&normalize_content(&[content])),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    out.insert("messages".into(), json!(messages));
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: usize = MCP_RESULT_MAX_BYTES;

    #[test]
    fn maps_text_image_audio_and_resource_blocks_to_the_project_shapes() {
        let blocks = normalize_content(&[
            json!({ "type": "text", "text": "caption" }),
            json!({ "type": "image", "data": "aGk=", "mimeType": "image/png" }),
            json!({ "type": "audio", "data": "aGk=", "mimeType": "audio/wav" }),
            json!({ "type": "resource", "resource": { "uri": "file:///notes.md", "mimeType": "text/markdown", "text": "notes" } }),
            json!({ "type": "resource", "resource": { "uri": "file:///doc.pdf", "mimeType": "application/pdf", "blob": "aGk=" } }),
        ]);
        assert_eq!(
            blocks,
            vec![
                json!({ "type": "text", "text": "caption" }),
                json!({ "type": "image", "data": "aGk=", "mimeType": "image/png" }),
                json!({ "type": "audio", "data": "aGk=", "mimeType": "audio/wav" }),
                json!({ "type": "resource", "uri": "file:///notes.md", "mimeType": "text/markdown", "text": "notes" }),
                json!({ "type": "resource", "uri": "file:///doc.pdf", "mimeType": "application/pdf", "blob": "aGk=" }),
            ]
        );
    }

    #[test]
    fn degrades_malformed_blocks_to_unknown_instead_of_failing() {
        let blocks = normalize_content(&[
            json!({ "type": "text", "text": 42 }),
            json!({ "type": "image", "mimeType": "image/png" }),
            json!({ "type": "resource", "resource": { "mimeType": "text/plain" } }),
            json!({ "type": "video", "mimeType": "video/mp4" }),
            json!({ "type": "resource_link", "uri": "file:///x", "name": "x" }),
        ]);
        assert_eq!(
            blocks,
            vec![
                json!({ "type": "unknown", "blockType": "text" }),
                json!({ "type": "unknown", "blockType": "image", "mimeType": "image/png" }),
                json!({ "type": "unknown", "blockType": "resource" }),
                json!({ "type": "unknown", "blockType": "video", "mimeType": "video/mp4" }),
                json!({ "type": "unknown", "blockType": "resource_link" }),
            ]
        );
    }

    #[test]
    fn caps_oversized_text_and_resource_text_in_structured_content() {
        let huge = "x".repeat(MAX + 1);
        let blocks = normalize_content(&[
            json!({ "type": "text", "text": huge }),
            json!({ "type": "resource", "resource": { "uri": "file:///big.md", "mimeType": "text/markdown", "text": huge } }),
        ]);
        assert_eq!(
            blocks[0],
            json!({ "type": "text", "text": "x".repeat(MAX), "truncated": true })
        );
        assert_eq!(
            blocks[1],
            json!({ "type": "resource", "uri": "file:///big.md", "mimeType": "text/markdown", "text": "x".repeat(MAX), "textTruncated": true })
        );
    }

    #[test]
    fn drops_oversized_image_audio_and_blob_payloads() {
        let huge = "y".repeat(MAX + 1);
        let blocks = normalize_content(&[
            json!({ "type": "image", "data": huge, "mimeType": "image/png" }),
            json!({ "type": "audio", "data": huge, "mimeType": "audio/wav" }),
            json!({ "type": "resource", "resource": { "uri": "file:///big.bin", "mimeType": "application/octet-stream", "blob": huge } }),
        ]);
        assert_eq!(
            blocks,
            vec![
                json!({ "type": "unknown", "blockType": "image", "mimeType": "image/png" }),
                json!({ "type": "unknown", "blockType": "audio", "mimeType": "audio/wav" }),
                json!({ "type": "unknown", "blockType": "resource", "mimeType": "application/octet-stream" }),
            ]
        );
    }

    #[test]
    fn joins_text_blocks_and_notes_rich_or_binary_blocks() {
        assert_eq!(
            flatten_content(&[
                json!({ "type": "text", "text": "first" }),
                json!({ "type": "text", "text": "second" })
            ]),
            "first\n\nsecond"
        );
        let text = flatten_content(&[
            json!({ "type": "text", "text": "caption" }),
            json!({ "type": "image", "data": "aGk=", "mimeType": "image/png" }),
            json!({ "type": "audio", "data": "aGk=", "mimeType": "audio/wav" }),
            json!({ "type": "resource", "uri": "file:///notes.md", "mimeType": "text/markdown", "text": "inline notes" }),
            json!({ "type": "resource", "uri": "file:///doc.pdf", "mimeType": "application/pdf", "blob": "aGk=" }),
            json!({ "type": "unknown", "blockType": "video" }),
        ]);
        assert_eq!(
            text,
            [
                "caption",
                "[image content, image/png]",
                "[audio content, audio/wav]",
                "inline notes",
                "[binary resource file:///doc.pdf, application/pdf]",
                "[unsupported video content]",
            ]
            .join("\n\n")
        );
        assert_eq!(flatten_content(&[]), "");
    }

    #[test]
    fn a_shortened_multi_byte_block_gets_the_marker() {
        let blocks = normalize_content(&[json!({ "type": "text", "text": "字".repeat(MAX) })]);
        assert_eq!(blocks[0]["truncated"], json!(true));
        let text = blocks[0]["text"].as_str().expect("text");
        assert!(
            text.len() < MAX,
            "expected fewer than {MAX} bytes | received {}",
            text.len()
        );
        assert!(flatten_content(&blocks).ends_with(MCP_RESULT_TRUNCATION_MARKER));
    }

    #[test]
    fn text_exactly_at_the_cap_passes_untouched() {
        let exact = "a".repeat(MAX);
        assert_eq!(
            flatten_content(&[json!({ "type": "text", "text": exact })]),
            exact
        );
        assert_eq!(cap_result_text(&exact), exact);
    }

    #[test]
    fn oversized_text_is_capped_with_the_marker_and_never_splits_a_character() {
        assert_eq!(
            cap_result_text(&"a".repeat(MAX + 1)),
            format!("{}{MCP_RESULT_TRUNCATION_MARKER}", "a".repeat(MAX))
        );
        let capped = cap_result_text(&format!("a{}", "é".repeat(MAX)));
        assert!(capped.ends_with(MCP_RESULT_TRUNCATION_MARKER));
        assert!(
            !capped.contains(REPLACEMENT),
            "expected no replacement character"
        );
        let flat = flatten_content(&normalize_content(&[
            json!({ "type": "text", "text": "x".repeat(MAX * 2) }),
        ]));
        assert!(flat.ends_with(MCP_RESULT_TRUNCATION_MARKER));
        assert!(flat.len() <= MAX + MCP_RESULT_TRUNCATION_MARKER.len());
    }

    #[test]
    fn a_genuine_replacement_character_at_the_cut_is_stripped_like_the_typescript_host() {
        // Buffer#toString decodes the cut lossily, then every trailing U+FFFD is removed —
        // including a real one that happened to sit right before the cut.
        let text = format!("{}{REPLACEMENT}{}", "a".repeat(MAX - 3), "b".repeat(10));
        assert_eq!(truncate_utf8(&text, MAX), "a".repeat(MAX - 3));
    }

    #[test]
    fn call_results_report_kinds_error_flag_and_capped_text() {
        let result = call_result(&json!({
            "content": [
                { "type": "text", "text": "done" },
                { "type": "image", "data": "aGk=", "mimeType": "image/png" },
            ],
            "isError": true,
        }));
        assert_eq!(
            result,
            json!({
                "contentText": "done\n\n[image content, image/png]",
                "isError": true,
                "rawContentKinds": ["text", "image"],
                "content": [
                    { "type": "text", "text": "done" },
                    { "type": "image", "data": "aGk=", "mimeType": "image/png" },
                ],
            })
        );
        assert_eq!(
            call_result(&json!({ "content": [] }))["isError"],
            json!(false)
        );
    }

    #[test]
    fn descriptors_match_the_typescript_field_presence() {
        assert_eq!(
            resource_descriptor(
                &json!({ "uri": "file:///a", "name": "a", "title": "A", "size": 3 })
            ),
            json!({ "uri": "file:///a", "name": "A", "sizeBytes": 3 })
        );
        assert_eq!(
            resource_descriptor(
                &json!({ "uri": "file:///b", "name": "b", "description": "d", "mimeType": "text/plain" })
            ),
            json!({ "uri": "file:///b", "name": "b", "description": "d", "mimeType": "text/plain" })
        );
        assert_eq!(
            resource_contents(
                &json!({ "uri": "file:///a", "text": "hi", "mimeType": "text/plain" })
            ),
            json!({ "uri": "file:///a", "mimeType": "text/plain", "text": "hi" })
        );
        assert_eq!(
            prompt_descriptor(
                &json!({ "name": "p", "arguments": [{ "name": "x", "required": true }, { "name": "y", "description": "why" }] })
            ),
            json!({ "name": "p", "arguments": [{ "name": "x", "required": true }, { "name": "y", "description": "why" }] })
        );
        assert_eq!(
            prompt_descriptor(&json!({ "name": "q" })),
            json!({ "name": "q", "arguments": [] })
        );
        assert_eq!(
            prompt_result(
                &json!({ "messages": [{ "role": "user", "content": { "type": "text", "text": "hello" } }] })
            ),
            json!({ "messages": [{ "role": "user", "text": "hello" }] })
        );
    }
}
