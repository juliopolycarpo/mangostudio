//! Private deserialization types. The embedded catalog validates the wire shapes.

use std::path::PathBuf;

use serde::Deserialize;

use super::policy::PathPolicy;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReadParams {
    pub chat_id: String,
    pub input_path: String,
    pub resolved_path: PathBuf,
    pub start_line: Option<f64>,
    pub max_lines: Option<f64>,
    pub view: Option<String>,
    pub path_policy: Option<PathPolicy>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Mutation {
    pub chat_id: String,
    pub capture_snapshot: bool,
    pub path_policy: Option<PathPolicy>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WriteParams {
    #[serde(flatten)]
    pub mutation: Mutation,
    pub input_path: String,
    pub resolved_path: PathBuf,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EditParams {
    #[serde(flatten)]
    pub mutation: Mutation,
    pub input_path: String,
    pub resolved_path: PathBuf,
    pub old_string: String,
    pub new_string: String,
    pub replace_all: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RangeParams {
    #[serde(flatten)]
    pub mutation: Mutation,
    pub input_path: String,
    pub resolved_path: PathBuf,
    pub start_line: f64,
    pub end_line: f64,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeleteParams {
    #[serde(flatten)]
    pub mutation: Mutation,
    pub input_path: String,
    pub resolved_path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MoveParams {
    #[serde(flatten)]
    pub mutation: Mutation,
    pub input_from: String,
    pub input_to: String,
    pub resolved_from: PathBuf,
    pub resolved_to: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListParams {
    pub input_path: String,
    pub resolved_path: PathBuf,
    pub path_policy: Option<PathPolicy>,
}

#[derive(Deserialize)]
pub(super) struct SnapshotCaptureParams {
    pub path: PathBuf,
}

#[derive(Deserialize)]
pub(super) struct SnapshotHashParams {
    pub path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotRevertParams {
    pub chat_id: String,
    pub containment_root: Option<PathBuf>,
    pub expected: Vec<SnapshotExpectedPath>,
    pub operations: Vec<SnapshotRevertOperation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotExpectedPath {
    pub path: PathBuf,
    pub after_hash: String,
    pub reverted_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum SnapshotRevertOperation {
    Create {
        path: PathBuf,
    },
    Restore {
        path: PathBuf,
        content_base64: String,
    },
    Move {
        path: PathBuf,
        moved_to: PathBuf,
        content_base64: String,
    },
}
