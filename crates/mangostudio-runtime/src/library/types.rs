//! Wire shapes the five read methods answer with, serialized exactly as
//! `apps/shared/src/library/schemas.ts` and
//! `apps/shared/src/runtime-contract/methods/library.ts` declare them. The
//! registry's result check validates every answer against the catalog, so a
//! field drifting here fails loudly rather than reaching a hub.

use serde::Serialize;

/// `LibraryInvalidReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum InvalidReason {
    PathEscape,
    InvalidSlug,
    MissingEntrypoint,
    UnexpectedEntryType,
    Unreadable,
    TooLarge,
    InvalidMetadata,
    UnsafeName,
}

/// `LibraryResourceRef`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ResourceRef {
    pub kind: &'static str,
    pub slug: String,
}

/// `LibraryInstance`: the valid and invalid variants share one struct, and
/// `valid`/`invalid_reason` plus the optional hash fields select between
/// them exactly as the schema's union does.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Instance {
    pub location_id: &'static str,
    pub path: String,
    pub modified_at_ms: u64,
    pub format: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid_reason: Option<InvalidReason>,
}

/// `RuntimeLibraryScanEntry`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanEntry {
    #[serde(rename = "ref")]
    pub resource: ResourceRef,
    pub instance: Instance,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whitespace_hash: Option<String>,
}

/// `LibraryUnreadableEntry`: an entry whose name cannot be a resource slug.
/// `invalid-name` is the only reason the contract defines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnreadableEntry {
    pub location_id: &'static str,
    pub name: String,
    pub reason: &'static str,
}

/// One location's (or one whole scan's) answer: `ReadLocationInstancesResult`
/// in TypeScript, `RuntimeLibraryScanResult` on the wire.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResult {
    pub entries: Vec<ScanEntry>,
    pub unreadable_entries: Vec<UnreadableEntry>,
}

impl ScanResult {
    pub(crate) fn instance(entry: ScanEntry) -> Self {
        Self {
            entries: vec![entry],
            unreadable_entries: Vec::new(),
        }
    }

    pub(crate) fn unreadable(entry: UnreadableEntry) -> Self {
        Self {
            entries: Vec::new(),
            unreadable_entries: vec![entry],
        }
    }

    pub(crate) fn extend(&mut self, other: Self) {
        self.entries.extend(other.entries);
        self.unreadable_entries.extend(other.unreadable_entries);
    }
}

/// `RuntimeLibraryReadResult`; `denied` is either absent or `true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadResult {
    pub content: String,
    pub truncated: bool,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ReadResult {
    /// The refusal shape `library.read` answers with instead of throwing.
    pub(crate) fn denied(reason: String) -> Self {
        Self {
            content: String::new(),
            truncated: false,
            size_bytes: 0,
            denied: Some(true),
            reason: Some(reason),
        }
    }
}

/// `RuntimeLibraryTreeFile`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreeFile {
    pub relative_path: String,
    pub content_base64: String,
}

/// `RuntimeLibraryReadTreeResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ReadTreeResult {
    pub files: Vec<TreeFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ReadTreeResult {
    pub(crate) fn denied(reason: String) -> Self {
        Self {
            files: Vec::new(),
            denied: Some(true),
            reason: Some(reason),
        }
    }
}
