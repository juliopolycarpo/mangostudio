//! Transaction-like application of structured filesystem patch operations.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::Engine;
use mango_protocol::error::{RemoteError, codes};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    freshness::ReadObservation,
    io,
    params::Mutation,
    patch::{self, V4aUpdateHunk},
    policy::CompiledPolicy,
    service::{Service, argument, preflight_response},
};
use crate::{blocking::run_blocking, ports::audit::lock};

/// Decoded parameters for `fs.apply-patch`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApplyPatchParams {
    #[serde(flatten)]
    mutation: Mutation,
    operations: Vec<PatchOperation>,
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum PatchOperation {
    Add {
        input_path: String,
        resolved_path: PathBuf,
        content: String,
    },
    Delete {
        input_path: String,
        resolved_path: PathBuf,
    },
    Update {
        input_path: String,
        resolved_path: PathBuf,
        move_to: Option<String>,
        resolved_move_to: Option<PathBuf>,
        hunks: Vec<V4aUpdateHunk>,
    },
}

enum PlannedOperation {
    Add {
        input_path: String,
        resolved_path: PathBuf,
        content: String,
    },
    Delete {
        input_path: String,
        resolved_path: PathBuf,
        source: Vec<u8>,
    },
    Update {
        input_path: String,
        resolved_path: PathBuf,
        move_to: Option<String>,
        resolved_move_to: Option<PathBuf>,
        source: Vec<u8>,
        content: String,
        has_content_changes: bool,
        line_numbers_valid_through_line: u64,
    },
}

trait CommitHook {
    fn after_final_policy_check(&self);
}

struct NoopCommitHook;

impl CommitHook for NoopCommitHook {
    fn after_final_policy_check(&self) {}
}

/// Plans, revalidates, and commits a multi-file patch under every Mango path lock.
///
/// The lock set serializes Mango mutations only. The tool contract requires the
/// calling environment to exclude unrelated writers until this operation finishes.
pub(super) async fn apply(
    service: Arc<Service>,
    params: ApplyPatchParams,
    cancel: CancellationToken,
    response_id: String,
    response_limit_bytes: usize,
) -> Result<Value, RemoteError> {
    let plan_params = params.clone();
    let planned = run_blocking({
        let service = Arc::clone(&service);
        let cancel = cancel.clone();
        move || plan_operations(&service, &plan_params, &cancel)
    })
    .await?;
    assert_no_path_conflicts(&planned)?;
    preflight_mutation_response(&params, &planned, response_id, response_limit_bytes)?;
    let paths = planned.iter().flat_map(operation_paths).collect::<Vec<_>>();
    let guards = service
        .state
        .locks
        .acquire(paths, &cancel)
        .await
        .map_err(|_| RemoteError::new(codes::CANCELLED, "Filesystem operation cancelled"))?;

    run_blocking(move || {
        let _guards = guards;
        commit_operations(&service, &params, &planned, &cancel)
    })
    .await
}

fn plan_operations(
    service: &Service,
    params: &ApplyPatchParams,
    cancel: &CancellationToken,
) -> Result<Vec<PlannedOperation>, RemoteError> {
    let mut planned = Vec::with_capacity(params.operations.len());
    let mut failures = Vec::new();
    for operation in &params.operations {
        match plan_operation(service, operation, &params.mutation, cancel) {
            Ok(operation) => planned.push(operation),
            Err(error) if matches!(error.code.as_str(), codes::DENIED | codes::CANCELLED) => {
                return Err(error);
            }
            Err(error) => failures.push((describe_operation(operation), error)),
        }
    }
    if failures.is_empty() {
        Ok(planned)
    } else {
        Err(operation_failures(failures))
    }
}

fn plan_operation(
    service: &Service,
    operation: &PatchOperation,
    mutation: &Mutation,
    cancel: &CancellationToken,
) -> Result<PlannedOperation, RemoteError> {
    let paths = raw_operation_paths(operation);
    let policy = service.compile_mutation_policy("fs.apply-patch", mutation, &paths, cancel)?;
    match operation {
        PatchOperation::Add {
            input_path,
            resolved_path,
            content,
        } => {
            assert_text(content, input_path)?;
            io::assert_destination_available(&policy, resolved_path, input_path)?;
            Ok(PlannedOperation::Add {
                input_path: input_path.clone(),
                resolved_path: resolved_path.clone(),
                content: content.clone(),
            })
        }
        PatchOperation::Delete {
            input_path,
            resolved_path,
        } => {
            let source =
                read_patch_target(service, &policy, &mutation.chat_id, resolved_path, cancel)?
                    .bytes;
            if mutation.capture_snapshot {
                super::service::snapshot_limit(resolved_path, source.len() as u64)?;
            }
            Ok(PlannedOperation::Delete {
                input_path: input_path.clone(),
                resolved_path: resolved_path.clone(),
                source,
            })
        }
        PatchOperation::Update {
            input_path,
            resolved_path,
            move_to,
            resolved_move_to,
            hunks,
        } => {
            if move_to.is_some() != resolved_move_to.is_some() {
                return Err(argument(format!(
                    "Invalid move fields for \"{input_path}\": received moveTo={} and resolvedMoveTo={}; expected both fields or neither.",
                    move_to.is_some(),
                    resolved_move_to.is_some()
                )));
            }
            let observed =
                read_patch_target(service, &policy, &mutation.chat_id, resolved_path, cancel)?;
            if mutation.capture_snapshot {
                super::service::snapshot_limit(resolved_path, observed.bytes.len() as u64)?;
            }
            let source = std::str::from_utf8(&observed.bytes).map_err(|_| {
                io::path_error(format!(
                    "Cannot patch \"{input_path}\": the file is not valid UTF-8 text."
                ))
            })?;
            // `TextDecoder` removes a leading UTF-8 BOM before the model sees
            // text. Match its visible text, then restore the byte-order mark
            // before committing the replacement bytes.
            let (bom, visible_source) = source
                .strip_prefix('\u{feff}')
                .map_or(("", source), |text| ("\u{feff}", text));
            let applied = patch::apply_update_hunks(visible_source, hunks, input_path)
                .map_err(|error| argument(error.to_string()))?;
            let content = format!("{bom}{}", applied.content);
            assert_text(&content, input_path)?;
            if let Some(destination) = resolved_move_to {
                if destination == resolved_path {
                    return Err(io::path_error(
                        "Source and move destination must be different paths.",
                    ));
                }
                io::assert_destination_available(
                    &policy,
                    destination,
                    move_to.as_deref().unwrap_or_default(),
                )?;
            }
            Ok(PlannedOperation::Update {
                input_path: input_path.clone(),
                resolved_path: resolved_path.clone(),
                move_to: move_to.clone(),
                resolved_move_to: resolved_move_to.clone(),
                source: observed.bytes,
                content,
                has_content_changes: !hunks.is_empty(),
                line_numbers_valid_through_line: applied.line_numbers_valid_through_line as u64,
            })
        }
    }
}

fn commit_operations(
    service: &Service,
    params: &ApplyPatchParams,
    planned: &[PlannedOperation],
    cancel: &CancellationToken,
) -> Result<Value, RemoteError> {
    let revalidated = revalidate_operations(service, params, planned, cancel)?;
    commit_revalidated(service, params, planned, &revalidated, cancel)
}

fn commit_revalidated(
    service: &Service,
    params: &ApplyPatchParams,
    planned: &[PlannedOperation],
    revalidated: &[Option<io::Observed>],
    cancel: &CancellationToken,
) -> Result<Value, RemoteError> {
    commit_revalidated_with_hook(
        service,
        params,
        planned,
        revalidated,
        cancel,
        &NoopCommitHook,
    )
}

fn commit_revalidated_with_hook(
    service: &Service,
    params: &ApplyPatchParams,
    planned: &[PlannedOperation],
    revalidated: &[Option<io::Observed>],
    cancel: &CancellationToken,
    hook: &dyn CommitHook,
) -> Result<Value, RemoteError> {
    let paths: Vec<_> = planned.iter().flat_map(operation_paths).collect();
    let borrowed_paths: Vec<_> = paths.iter().map(PathBuf::as_path).collect();
    let policy = service.compile_mutation_policy(
        "fs.apply-patch",
        &params.mutation,
        &borrowed_paths,
        cancel,
    )?;
    hook.after_final_policy_check();

    let mut writes = vec![None; planned.len()];
    let mut move_hashes = vec![None; planned.len()];
    let mut changed_paths = Vec::new();
    for (index, operation) in planned.iter().enumerate() {
        let result = match operation {
            PlannedOperation::Add {
                resolved_path,
                content,
                ..
            } => io::write_atomic(&policy, resolved_path, content.as_bytes(), true),
            PlannedOperation::Update {
                resolved_path,
                content,
                has_content_changes: true,
                ..
            } => io::write_atomic_if_unchanged(
                &policy,
                resolved_path,
                &revalidated[index]
                    .as_ref()
                    .expect("updates are revalidated before commit")
                    .bytes,
                content.as_bytes(),
            ),
            PlannedOperation::Delete { .. }
            | PlannedOperation::Update {
                has_content_changes: false,
                ..
            } => continue,
        };
        match result {
            Ok(mtime_ms) => {
                writes[index] = Some(mtime_ms);
                changed_paths.push(operation.primary_path().to_path_buf());
            }
            Err(error) => return Err(commit_error(&changed_paths, error)),
        }
    }
    for (index, operation) in planned.iter().enumerate() {
        let PlannedOperation::Update {
            resolved_path,
            resolved_move_to: Some(destination),
            ..
        } = operation
        else {
            continue;
        };
        if let Err(error) = io::move_no_overwrite(&policy, resolved_path, destination) {
            record_uncertain_move_paths(&mut changed_paths, resolved_path, destination, &error);
            return Err(commit_error(&changed_paths, error));
        }
        changed_paths.push(resolved_path.clone());
        changed_paths.push(destination.clone());
        match io::hash_file(&policy, destination) {
            Ok(hash) => move_hashes[index] = Some(hash),
            Err(error) => return Err(commit_error(&changed_paths, error)),
        }
    }
    for operation in planned {
        let PlannedOperation::Delete { resolved_path, .. } = operation else {
            continue;
        };
        if let Err(error) = io::delete_file(&policy, resolved_path) {
            let error = if error
                .details
                .as_ref()
                .and_then(|details| details.get("notFound"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                super::freshness::stale_file_error(resolved_path)
            } else {
                error
            };
            return Err(commit_error(&changed_paths, error));
        }
        changed_paths.push(resolved_path.clone());
    }
    outcomes(service, params, planned, revalidated, &writes, &move_hashes)
}

fn record_uncertain_move_paths(
    changed_paths: &mut Vec<PathBuf>,
    source: &Path,
    destination: &Path,
    error: &RemoteError,
) {
    let changed = error
        .details
        .as_ref()
        .and_then(|details| details.get("pathsMayHaveChanged"))
        .and_then(Value::as_bool)
        == Some(true);
    if changed {
        changed_paths.push(source.to_path_buf());
        changed_paths.push(destination.to_path_buf());
    }
}

fn revalidate_operations(
    service: &Service,
    params: &ApplyPatchParams,
    planned: &[PlannedOperation],
    cancel: &CancellationToken,
) -> Result<Vec<Option<io::Observed>>, RemoteError> {
    let mut values = Vec::with_capacity(planned.len());
    let mut failures = Vec::new();
    for operation in planned {
        let checked = match operation {
            PlannedOperation::Add {
                input_path,
                resolved_path,
                ..
            } => service
                .compile_mutation_policy(
                    "fs.apply-patch",
                    &params.mutation,
                    &[resolved_path],
                    cancel,
                )
                .and_then(|policy| {
                    io::assert_destination_available(&policy, resolved_path, input_path)
                })
                .map(|()| None),
            PlannedOperation::Delete {
                input_path: _,
                resolved_path,
                source,
            }
            | PlannedOperation::Update {
                input_path: _,
                resolved_path,
                source,
                ..
            } => {
                let checked = service
                    .compile_mutation_policy(
                        "fs.apply-patch",
                        &params.mutation,
                        &[resolved_path],
                        cancel,
                    )
                    .and_then(|policy| {
                        read_patch_target(
                            service,
                            &policy,
                            &params.mutation.chat_id,
                            resolved_path,
                            cancel,
                        )
                    });
                checked.and_then(|observed| {
                    if observed.bytes != *source {
                        return Err(super::freshness::stale_file_error(resolved_path));
                    }
                    if let PlannedOperation::Update {
                        resolved_move_to: Some(destination),
                        move_to,
                        ..
                    } = operation
                    {
                        let policy = service.compile_mutation_policy(
                            "fs.apply-patch",
                            &params.mutation,
                            &[destination],
                            cancel,
                        )?;
                        io::assert_destination_available(
                            &policy,
                            destination,
                            move_to.as_deref().unwrap_or_default(),
                        )?;
                    }
                    Ok(Some(observed))
                })
            }
        };
        match checked {
            Ok(value) => values.push(value),
            Err(error) => {
                if matches!(error.code.as_str(), codes::DENIED | codes::CANCELLED) {
                    return Err(error);
                }
                failures.push((describe_planned(operation), error));
                values.push(None);
            }
        }
    }
    if failures.is_empty() {
        Ok(values)
    } else {
        Err(operation_failures(failures))
    }
}

fn outcomes(
    service: &Service,
    params: &ApplyPatchParams,
    planned: &[PlannedOperation],
    revalidated: &[Option<io::Observed>],
    writes: &[Option<f64>],
    move_hashes: &[Option<String>],
) -> Result<Value, RemoteError> {
    let mut files = Vec::with_capacity(planned.len());
    let mut mutations = Vec::new();
    for (index, operation) in planned.iter().enumerate() {
        match operation {
            PlannedOperation::Add {
                input_path,
                resolved_path,
                content,
            } => {
                let mtime = writes[index].expect("committed add has a write timestamp");
                let sha256 = lock(&service.state.ledger).record_read(
                    &params.mutation.chat_id,
                    resolved_path,
                    content.as_bytes(),
                    mtime,
                    ReadObservation::WholeFile,
                );
                files.push(json!({"path":input_path,"op":"add","sha256":sha256}));
                push_snapshot(
                    &mut mutations,
                    params,
                    resolved_path,
                    "create",
                    None,
                    None,
                    &sha256,
                );
            }
            PlannedOperation::Delete {
                input_path,
                resolved_path,
                ..
            } => {
                let current = revalidated[index].as_ref().expect("delete was revalidated");
                lock(&service.state.ledger).forget(&params.mutation.chat_id, resolved_path);
                files.push(json!({"path":input_path,"op":"delete"}));
                push_snapshot(
                    &mut mutations,
                    params,
                    resolved_path,
                    "delete",
                    Some(&current.bytes),
                    None,
                    "absent",
                );
            }
            PlannedOperation::Update {
                input_path,
                resolved_path,
                move_to,
                resolved_move_to,
                content,
                has_content_changes,
                line_numbers_valid_through_line,
                ..
            } => {
                let current = revalidated[index].as_ref().expect("update was revalidated");
                let target = resolved_move_to.as_ref().unwrap_or(resolved_path);
                if resolved_move_to.is_some() {
                    lock(&service.state.ledger).rekey(
                        &params.mutation.chat_id,
                        resolved_path,
                        target,
                    );
                }
                let mtime = writes[index].unwrap_or(current.mtime_ms);
                let sha256 = if *has_content_changes {
                    lock(&service.state.ledger).record_edit(
                        &params.mutation.chat_id,
                        target,
                        content.as_bytes(),
                        mtime,
                        *line_numbers_valid_through_line,
                    )
                } else {
                    lock(&service.state.ledger).record_read(
                        &params.mutation.chat_id,
                        target,
                        &current.bytes,
                        mtime,
                        ReadObservation::WholeFile,
                    )
                };
                if let Some(moved_to) = move_to {
                    files.push(
                        json!({"path":input_path,"op":"move","movedTo":moved_to,"sha256":sha256}),
                    );
                    push_snapshot(
                        &mut mutations,
                        params,
                        resolved_path,
                        "move",
                        Some(&current.bytes),
                        Some(target),
                        move_hashes[index]
                            .as_deref()
                            .expect("committed move has a destination hash"),
                    );
                } else {
                    files.push(json!({"path":input_path,"op":"update","sha256":sha256}));
                    push_snapshot(
                        &mut mutations,
                        params,
                        resolved_path,
                        "edit",
                        Some(&current.bytes),
                        None,
                        &sha256,
                    );
                }
            }
        }
    }
    let count = files.len();
    Ok(
        json!({"result":{"files":files,"summary":format!("{count} {} changed", if count == 1 { "file" } else { "files" })},"mutations":mutations}),
    )
}

fn preflight_mutation_response(
    params: &ApplyPatchParams,
    planned: &[PlannedOperation],
    response_id: String,
    response_limit_bytes: usize,
) -> Result<(), RemoteError> {
    const HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
    let mut files = Vec::with_capacity(planned.len());
    let mut mutations = Vec::with_capacity(planned.len());
    for operation in planned {
        match operation {
            PlannedOperation::Add {
                input_path,
                resolved_path,
                ..
            } => {
                files.push(json!({"path":input_path,"op":"add","sha256":HASH}));
                push_snapshot(
                    &mut mutations,
                    params,
                    resolved_path,
                    "create",
                    None,
                    None,
                    HASH,
                );
            }
            PlannedOperation::Delete {
                input_path,
                resolved_path,
                source,
            } => {
                files.push(json!({"path":input_path,"op":"delete"}));
                push_snapshot(
                    &mut mutations,
                    params,
                    resolved_path,
                    "delete",
                    Some(source),
                    None,
                    "absent",
                );
            }
            PlannedOperation::Update {
                input_path,
                resolved_path,
                move_to,
                resolved_move_to,
                source,
                ..
            } => {
                if let Some(moved_to) = move_to {
                    files.push(
                        json!({"path":input_path,"op":"move","movedTo":moved_to,"sha256":HASH}),
                    );
                    push_snapshot(
                        &mut mutations,
                        params,
                        resolved_path,
                        "move",
                        Some(source),
                        resolved_move_to.as_deref(),
                        HASH,
                    );
                } else {
                    files.push(json!({"path":input_path,"op":"update","sha256":HASH}));
                    push_snapshot(
                        &mut mutations,
                        params,
                        resolved_path,
                        "edit",
                        Some(source),
                        None,
                        HASH,
                    );
                }
            }
        }
    }
    let count = files.len();
    let result = json!({"result":{"files":files,"summary":format!("{count} {} changed", if count == 1 { "file" } else { "files" })},"mutations":mutations});
    preflight_response(&result, &response_id, response_limit_bytes, "patch")
}

fn push_snapshot(
    output: &mut Vec<Value>,
    params: &ApplyPatchParams,
    path: &Path,
    op: &str,
    before: Option<&[u8]>,
    moved_to: Option<&Path>,
    after_hash: &str,
) {
    if !params.mutation.capture_snapshot {
        return;
    }
    let before = before.map_or_else(|| json!({"exists":false}), |bytes| json!({"exists":true,"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"hash":io::sha256_hex(bytes)}));
    let mut snapshot = json!({"path":path,"op":op,"before":before,"afterHash":after_hash});
    if let Some(destination) = moved_to {
        snapshot["movedTo"] = json!(destination);
    }
    output.push(snapshot);
}

fn read_patch_target(
    service: &Service,
    policy: &CompiledPolicy,
    chat_id: &str,
    path: &Path,
    cancel: &CancellationToken,
) -> Result<super::io::Observed, RemoteError> {
    io::assert_regular(policy, path, "patch")?;
    service
        .read_fresh(policy, chat_id, path, cancel)
        .map_err(|error| io::explain_unread(policy, path, "patch", error))
}

fn assert_text(content: &str, input_path: &str) -> Result<(), RemoteError> {
    patch::assert_text_content(content, input_path).map_err(|error| argument(error.to_string()))
}

fn assert_no_path_conflicts(planned: &[PlannedOperation]) -> Result<(), RemoteError> {
    let mut owners: Vec<(PathBuf, String)> = Vec::new();
    let mut failures = Vec::new();
    for operation in planned {
        let description = describe_planned(operation);
        for path in operation_paths(operation) {
            let effective = crate::workspace::resolve_through_existing_ancestor(&path)
                .unwrap_or_else(|| path.clone());
            if let Some((_, owner)) = owners.iter().find(|(owned, _)| {
                super::policy::is_prefix(owned, &effective)
                    || super::policy::is_prefix(&effective, owned)
            }) {
                failures.push(format!("{description}: path conflicts with {owner}."));
            } else {
                owners.push((effective, description.clone()));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(argument(format!(
            "Patch could not be applied:\n{}",
            failures
                .into_iter()
                .map(|failure| format!("- {failure}"))
                .collect::<Vec<_>>()
                .join("\n")
        )))
    }
}

fn operation_failures(mut failures: Vec<(String, RemoteError)>) -> RemoteError {
    if failures.len() == 1 {
        let (description, mut error) = failures.pop().expect("one failure exists");
        error.message = format!(
            "Patch could not be applied:\n- {description}: {}",
            error.message
        );
        return error;
    }
    argument(format!(
        "Patch could not be applied:\n{}",
        failures
            .into_iter()
            .map(|(description, error)| format!("- {description}: {}", error.message))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

fn commit_error(changed_paths: &[PathBuf], cause: RemoteError) -> RemoteError {
    let mut unique = Vec::new();
    for path in changed_paths {
        if !unique.contains(path) {
            unique.push(path.clone());
        }
    }
    let changed = if unique.is_empty() {
        String::new()
    } else {
        format!(
            " Paths already modified: {}.",
            unique
                .iter()
                .map(|path| format!("\"{}\"", path.display()))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let mut error = io::path_error(format!(
        "Patch commit failed.{changed} Inspect any listed paths before retrying. Cause: {}",
        cause.message
    ));
    if !unique.is_empty() {
        error = error.with_detail("changedPaths", json!(unique));
    }
    error
}

impl PlannedOperation {
    fn primary_path(&self) -> &Path {
        match self {
            Self::Add { resolved_path, .. }
            | Self::Delete { resolved_path, .. }
            | Self::Update { resolved_path, .. } => resolved_path,
        }
    }
}

fn operation_paths(operation: &PlannedOperation) -> Vec<PathBuf> {
    match operation {
        PlannedOperation::Update {
            resolved_path,
            resolved_move_to: Some(destination),
            ..
        } => vec![resolved_path.clone(), destination.clone()],
        _ => vec![operation.primary_path().to_path_buf()],
    }
}

fn raw_operation_paths(operation: &PatchOperation) -> Vec<&Path> {
    match operation {
        PatchOperation::Update {
            resolved_path,
            resolved_move_to: Some(destination),
            ..
        } => vec![resolved_path, destination],
        PatchOperation::Add { resolved_path, .. }
        | PatchOperation::Delete { resolved_path, .. }
        | PatchOperation::Update { resolved_path, .. } => vec![resolved_path],
    }
}

fn describe_operation(operation: &PatchOperation) -> String {
    match operation {
        PatchOperation::Add { input_path, .. } => format!("Add \"{input_path}\""),
        PatchOperation::Delete { input_path, .. } => format!("Delete \"{input_path}\""),
        PatchOperation::Update { input_path, .. } => format!("Update \"{input_path}\""),
    }
}

fn describe_planned(operation: &PlannedOperation) -> String {
    match operation {
        PlannedOperation::Add { input_path, .. } => format!("Add \"{input_path}\""),
        PlannedOperation::Delete { input_path, .. } => format!("Delete \"{input_path}\""),
        PlannedOperation::Update { input_path, .. } => format!("Update \"{input_path}\""),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use serde_json::json;

    use super::*;
    use crate::{
        consent::source::ConsentSource,
        filesystem::{
            freshness::{ObservedLineRange, ReadObservation},
            policy::PathPolicy,
            service::{NativeMoveIo, NativeWriteIo, State},
        },
        runtime_home::RuntimeSlot,
        test_support::{ScratchDir, scratch_dir},
    };

    fn fixture() -> (ScratchDir, Arc<Service>) {
        let home = scratch_dir("patch-apply");
        let service = Arc::new(Service {
            state: Arc::new(State::default()),
            consent: ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()),
            move_io: Arc::new(NativeMoveIo),
            write_io: Arc::new(NativeWriteIo),
        });
        (home, service)
    }

    fn params(value: Value) -> ApplyPatchParams {
        serde_json::from_value(value).expect("valid apply-patch parameters")
    }

    async fn apply(
        service: Arc<Service>,
        params: ApplyPatchParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        super::apply(
            service,
            params,
            cancel,
            "test-request".to_string(),
            mango_protocol::codec::ndjson::DEFAULT_MAX_FRAME_BYTES,
        )
        .await
    }

    fn mark_read(service: &Service, path: &Path) {
        let bytes = fs::read(path).expect("fixture file exists");
        lock(&service.state.ledger).record_read(
            "chat",
            path,
            &bytes,
            f64::NAN,
            ReadObservation::WholeFile,
        );
    }

    #[cfg(unix)]
    struct SwapAfterFinalPolicyCheck {
        link: PathBuf,
        replacement: PathBuf,
    }

    #[cfg(unix)]
    impl CommitHook for SwapAfterFinalPolicyCheck {
        fn after_final_policy_check(&self) {
            fs::remove_file(&self.link).unwrap();
            std::os::unix::fs::symlink(&self.replacement, &self.link).unwrap();
        }
    }

    #[tokio::test]
    async fn commits_add_update_delete_and_move_then_records_snapshots() {
        let (home, service) = fixture();
        let update = home.join("update.txt");
        let delete = home.join("delete.txt");
        let moved = home.join("moved.txt");
        fs::write(&update, "old\n").unwrap();
        fs::write(&delete, "gone\n").unwrap();
        fs::write(&moved, "move\n").unwrap();
        for path in [&update, &delete, &moved] {
            mark_read(&service, path);
        }
        let added = home.join("added.txt");
        let moved_to = home.join("moved-to.txt");
        let result = apply(
            Arc::clone(&service),
            params(json!({
                "chatId":"chat", "captureSnapshot":true,
                "operations":[
                    {"type":"add","inputPath":"added.txt","resolvedPath":added,"content":"added\n"},
                    {"type":"update","inputPath":"update.txt","resolvedPath":update,"hunks":[{"lines":[{"type":"delete","content":"old","ending":"\n"},{"type":"add","content":"new","ending":"\n"}]}]},
                    {"type":"delete","inputPath":"delete.txt","resolvedPath":delete},
                    {"type":"update","inputPath":"moved.txt","resolvedPath":moved,"moveTo":"moved-to.txt","resolvedMoveTo":moved_to,"hunks":[]}
                ]
            })),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(&added).unwrap(), "added\n");
        assert_eq!(fs::read_to_string(&update).unwrap(), "new\n");
        assert!(!delete.exists());
        assert_eq!(fs::read_to_string(&moved_to).unwrap(), "move\n");
        assert!(!moved.exists());
        assert_eq!(result["result"]["summary"], "4 files changed");
        assert_eq!(result["mutations"].as_array().unwrap().len(), 4);
        assert_eq!(result["mutations"][2]["afterHash"], "absent");
    }

    #[tokio::test]
    async fn rejects_unpaired_move_fields_before_reading_or_mutating() {
        let (home, service) = fixture();
        let source = home.join("source.txt");
        let destination = home.join("destination.txt");
        fs::write(&source, "unchanged\n").unwrap();

        for operation in [
            json!({"type":"update","inputPath":"source.txt","resolvedPath":source,"moveTo":"destination.txt","hunks":[]}),
            json!({"type":"update","inputPath":"source.txt","resolvedPath":source,"resolvedMoveTo":destination,"hunks":[]}),
        ] {
            let error = apply(
                Arc::clone(&service),
                params(json!({
                    "chatId":"chat", "captureSnapshot":true, "operations":[operation]
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.details.unwrap()["kind"], "tool_argument");
            assert!(error.message.contains("expected both fields or neither"));
            assert_eq!(fs::read_to_string(&source).unwrap(), "unchanged\n");
            assert!(!destination.exists());
        }
    }

    #[tokio::test]
    async fn refuses_unread_partial_and_stale_sources_before_any_write() {
        let (home, service) = fixture();
        let file = home.join("source.txt");
        fs::write(&file, "one\ntwo\n").unwrap();
        let patch = || {
            params(
                json!({"chatId":"chat","captureSnapshot":false,"operations":[{"type":"update","inputPath":"source.txt","resolvedPath":file,"hunks":[{"lines":[{"type":"delete","content":"one","ending":"\n"},{"type":"add","content":"first","ending":"\n"}]}]}]}),
            )
        };
        let unread = apply(Arc::clone(&service), patch(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(unread.details.unwrap()["kind"], "file_not_read");
        lock(&service.state.ledger).record_read(
            "chat",
            &file,
            b"one\ntwo\n",
            f64::NAN,
            ReadObservation::Window(ObservedLineRange {
                start_line: 1,
                end_line: 1,
                total_lines: 2,
            }),
        );
        let partial = apply(Arc::clone(&service), patch(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(partial.details.unwrap()["kind"], "partial_read");
        mark_read(&service, &file);
        fs::write(&file, "outside\n").unwrap();
        let stale = apply(Arc::clone(&service), patch(), CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(stale.details.unwrap()["kind"], "stale_file");
        assert_eq!(fs::read_to_string(&file).unwrap(), "outside\n");
    }

    #[tokio::test]
    async fn matches_a_bom_stripped_text_view_and_preserves_its_bom() {
        let (home, service) = fixture();
        let file = home.join("bom.txt");
        fs::write(&file, "\u{feff}old\n").unwrap();
        mark_read(&service, &file);
        apply(Arc::clone(&service), params(json!({"chatId":"chat","captureSnapshot":false,"operations":[{"type":"update","inputPath":"bom.txt","resolvedPath":file,"hunks":[{"lines":[{"type":"delete","content":"old","ending":"\n"},{"type":"add","content":"new","ending":"\n"}]}]}]})), CancellationToken::new()).await.unwrap();
        assert_eq!(fs::read(&file).unwrap(), "\u{feff}new\n".as_bytes());
    }

    #[tokio::test]
    async fn conflicts_leave_every_destination_untouched_and_cancellation_leaks_no_lock() {
        let (home, service) = fixture();
        let file = home.join("conflict.txt");
        let conflict = apply(Arc::clone(&service), params(json!({"chatId":"chat","captureSnapshot":false,"operations":[{"type":"add","inputPath":"a","resolvedPath":file,"content":"one"},{"type":"add","inputPath":"b","resolvedPath":file,"content":"two"}]})), CancellationToken::new()).await.unwrap_err();
        assert_eq!(conflict.details.unwrap()["kind"], "tool_argument");
        assert!(!file.exists());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error = apply(
            Arc::clone(&service),
            params(json!({"chatId":"chat","captureSnapshot":false,"operations":[] })),
            cancelled,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        assert_eq!(service.state.locks.active_paths(), 0);
    }

    #[tokio::test]
    async fn rejects_ancestor_conflicts_in_either_order_before_any_write() {
        for reverse in [false, true] {
            let (home, service) = fixture();
            let parent = home.join("parent");
            let child = parent.join("child.txt");
            let mut operations = vec![
                json!({"type":"add","inputPath":"parent","resolvedPath":parent,"content":"parent"}),
                json!({"type":"add","inputPath":"parent/child.txt","resolvedPath":child,"content":"child"}),
            ];
            if reverse {
                operations.reverse();
            }
            let error = apply(
                Arc::clone(&service),
                params(json!({"chatId":"chat","captureSnapshot":false,"operations":operations})),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.details.unwrap()["kind"], "tool_argument");
            assert!(!parent.exists());
            assert!(!child.exists());
        }

        let (home, service) = fixture();
        let first = home.join("name");
        let second = home.join("name-longer");
        apply(
            service,
            params(
                json!({"chatId":"chat","captureSnapshot":false,"operations":[
                    {"type":"add","inputPath":"name","resolvedPath":first,"content":"one"},
                    {"type":"add","inputPath":"name-longer","resolvedPath":second,"content":"two"}
                ]}),
            ),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(first).unwrap(), "one");
        assert_eq!(fs::read_to_string(second).unwrap(), "two");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_patch_conflicts_reached_through_symlinked_parents() {
        use std::os::unix::fs::symlink;

        let (home, service) = fixture();
        let real = home.join("real");
        let alias = home.join("alias");
        fs::create_dir(&real).unwrap();
        symlink(&real, &alias).unwrap();
        let aliased = alias.join("file.txt");
        let direct = real.join("file.txt");
        fs::write(&direct, "unchanged\n").unwrap();
        mark_read(&service, &aliased);
        mark_read(&service, &direct);
        let error = apply(
            service,
            params(
                json!({"chatId":"chat","captureSnapshot":false,"operations":[
                    {"type":"delete","inputPath":"alias/file.txt","resolvedPath":aliased},
                    {"type":"delete","inputPath":"real/file.txt","resolvedPath":direct}
                ]}),
            ),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "tool_argument");
        assert_eq!(
            fs::read_to_string(real.join("file.txt")).unwrap(),
            "unchanged\n"
        );
    }

    #[tokio::test]
    async fn rejects_an_aggregate_snapshot_past_the_frame_limit_before_mutating() {
        let (home, service) = fixture();
        let first = home.join("first.txt");
        let second = home.join("second.txt");
        fs::write(&first, vec![b'a'; 1_600]).unwrap();
        fs::write(&second, vec![b'b'; 1_600]).unwrap();
        mark_read(&service, &first);
        mark_read(&service, &second);
        let error = super::apply(
            service,
            params(json!({"chatId":"chat","captureSnapshot":true,"operations":[
                {"type":"delete","inputPath":"first.txt","resolvedPath":first},
                {"type":"delete","inputPath":"second.txt","resolvedPath":second}
            ]})),
            CancellationToken::new(),
            "small-frame".to_string(),
            mango_protocol::codec::ndjson::MIN_MAX_FRAME_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, codes::FRAME_TOO_LARGE);
        assert_eq!(
            error.details.as_ref().unwrap()["kind"],
            "snapshot_too_large"
        );
        assert_eq!(error.details.as_ref().unwrap()["limitBytes"], 4_096);
        assert_eq!(fs::read(&first).unwrap(), vec![b'a'; 1_600]);
        assert_eq!(fs::read(&second).unwrap(), vec![b'b'; 1_600]);
    }

    #[tokio::test]
    async fn rejects_an_aggregate_patch_result_past_the_frame_limit_before_mutating() {
        let (home, service) = fixture();
        let paths = (0..40)
            .map(|index| home.join(format!("result-{index:02}-{}", "x".repeat(100))))
            .collect::<Vec<_>>();
        let operations = paths
            .iter()
            .map(|path| {
                json!({
                    "type":"add",
                    "inputPath":path.file_name().and_then(|name| name.to_str()).unwrap(),
                    "resolvedPath":path,
                    "content":"new"
                })
            })
            .collect::<Vec<_>>();

        let error = super::apply(
            service,
            params(json!({
                "chatId":"chat", "captureSnapshot":false, "operations":operations
            })),
            CancellationToken::new(),
            "small-frame".to_string(),
            mango_protocol::codec::ndjson::MIN_MAX_FRAME_BYTES,
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, codes::FRAME_TOO_LARGE);
        assert_eq!(error.details.as_ref().unwrap()["limitBytes"], 4_096);
        assert!(paths.iter().all(|path| !path.exists()));
    }

    #[test]
    fn move_snapshot_uses_the_committed_destination_hash() {
        let (home, service) = fixture();
        let source = home.join("source.txt");
        let destination = home.join("destination.txt");
        fs::write(&source, "source\n").unwrap();
        mark_read(&service, &source);
        let parameters = params(json!({
            "chatId":"chat", "captureSnapshot":true,
            "operations":[{"type":"update","inputPath":"source.txt","resolvedPath":source,"moveTo":"destination.txt","resolvedMoveTo":destination,"hunks":[]}]
        }));
        let cancel = CancellationToken::new();
        let planned = plan_operations(&service, &parameters, &cancel).unwrap();
        let revalidated = revalidate_operations(&service, &parameters, &planned, &cancel).unwrap();
        let policy = PathPolicy::default().compile().unwrap();
        io::move_no_overwrite(&policy, &source, &destination).unwrap();
        fs::write(&destination, "external\n").unwrap();
        let committed_hash = io::hash_file(&policy, &destination).unwrap();
        let result = outcomes(
            &service,
            &parameters,
            &planned,
            &revalidated,
            &[None],
            &[Some(committed_hash.clone())],
        )
        .unwrap();
        assert_eq!(result["mutations"][0]["afterHash"], committed_hash);
        assert_ne!(result["result"]["files"][0]["sha256"], committed_hash);
    }

    #[test]
    fn reports_both_move_paths_when_a_later_move_fails() {
        let (home, service) = fixture();
        let first = home.join("first.txt");
        let first_to = home.join("first-to.txt");
        let second = home.join("second.txt");
        let second_to = home.join("second-to.txt");
        fs::write(&first, "one\n").unwrap();
        fs::write(&second, "two\n").unwrap();
        mark_read(&service, &first);
        mark_read(&service, &second);
        let parameters = params(json!({
            "chatId":"chat", "captureSnapshot":false,
            "operations":[
                {"type":"update","inputPath":"first.txt","resolvedPath":first,"moveTo":"first-to.txt","resolvedMoveTo":first_to,"hunks":[]},
                {"type":"update","inputPath":"second.txt","resolvedPath":second,"moveTo":"second-to.txt","resolvedMoveTo":second_to,"hunks":[]}
            ]
        }));
        let cancel = CancellationToken::new();
        let planned = plan_operations(&service, &parameters, &cancel).unwrap();
        let revalidated = revalidate_operations(&service, &parameters, &planned, &cancel).unwrap();
        fs::write(&second_to, "external\n").unwrap();
        let error =
            commit_revalidated(&service, &parameters, &planned, &revalidated, &cancel).unwrap_err();
        assert_eq!(
            error.details.unwrap()["changedPaths"],
            json!([first, first_to])
        );
        assert!(!first.exists());
        assert_eq!(fs::read_to_string(first_to).unwrap(), "one\n");
        assert_eq!(fs::read_to_string(second).unwrap(), "two\n");
    }

    #[test]
    fn reports_both_move_paths_when_publication_may_have_partially_failed() {
        let source = PathBuf::from("source.txt");
        let destination = PathBuf::from("destination.txt");
        let error = io::path_error("partial move").with_detail("pathsMayHaveChanged", true);
        let mut changed_paths = Vec::new();
        record_uncertain_move_paths(&mut changed_paths, &source, &destination, &error);
        assert_eq!(changed_paths, vec![source, destination]);
    }

    #[test]
    fn refuses_a_later_patch_write_changed_after_revalidation() {
        let (home, service) = fixture();
        let first = home.join("first.txt");
        let second = home.join("second.txt");
        fs::write(&first, "one\n").unwrap();
        fs::write(&second, "two\n").unwrap();
        mark_read(&service, &first);
        mark_read(&service, &second);
        let parameters = params(json!({
            "chatId":"chat", "captureSnapshot":false,
            "operations":[
                {"type":"update","inputPath":"first.txt","resolvedPath":first,"hunks":[{"lines":[{"type":"delete","content":"one","ending":"\n"},{"type":"add","content":"first","ending":"\n"}]}]},
                {"type":"update","inputPath":"second.txt","resolvedPath":second,"hunks":[{"lines":[{"type":"delete","content":"two","ending":"\n"},{"type":"add","content":"second","ending":"\n"}]}]}
            ]
        }));
        let cancel = CancellationToken::new();
        let planned = plan_operations(&service, &parameters, &cancel).unwrap();
        let revalidated = revalidate_operations(&service, &parameters, &planned, &cancel).unwrap();
        fs::write(&second, "external\n").unwrap();

        let error =
            commit_revalidated(&service, &parameters, &planned, &revalidated, &cancel).unwrap_err();

        assert_eq!(error.details.as_ref().unwrap()["kind"], "path_access");
        assert!(error.message.contains("file changed after revalidation"));
        assert_eq!(
            error.details.as_ref().unwrap()["changedPaths"],
            json!([first])
        );
        assert_eq!(fs::read_to_string(&first).unwrap(), "first\n");
        assert_eq!(fs::read_to_string(&second).unwrap(), "external\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_paths_already_changed_when_a_later_commit_write_fails() {
        use std::os::unix::fs::PermissionsExt;

        let (home, service) = fixture();
        let first = home.join("first.txt");
        let second = home.join("second.txt");
        fs::write(&first, "one\n").unwrap();
        fs::write(&second, "two\n").unwrap();
        mark_read(&service, &first);
        mark_read(&service, &second);
        fs::set_permissions(&second, fs::Permissions::from_mode(0o444)).unwrap();
        let error = apply(
            Arc::clone(&service),
            params(json!({"chatId":"chat","captureSnapshot":false,"operations":[
                {"type":"update","inputPath":"first.txt","resolvedPath":first,"hunks":[{"lines":[{"type":"delete","content":"one","ending":"\n"},{"type":"add","content":"first","ending":"\n"}]}]},
                {"type":"update","inputPath":"second.txt","resolvedPath":second,"hunks":[{"lines":[{"type":"delete","content":"two","ending":"\n"},{"type":"add","content":"second","ending":"\n"}]}]}
            ]})),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.details.as_ref().unwrap()["kind"], "path_access");
        assert_eq!(
            error.details.as_ref().unwrap()["changedPaths"],
            json!([first])
        );
        assert_eq!(fs::read_to_string(&first).unwrap(), "first\n");
        assert_eq!(fs::read_to_string(&second).unwrap(), "two\n");
    }

    #[tokio::test]
    async fn cancellation_while_queued_for_the_patch_lock_has_no_effect() {
        let (home, service) = fixture();
        let file = home.join("queued.txt");
        fs::write(&file, "old\n").unwrap();
        mark_read(&service, &file);
        let held = service
            .state
            .locks
            .acquire(vec![file.clone()], &CancellationToken::new())
            .await
            .unwrap();
        let cancel = CancellationToken::new();
        let task = tokio::spawn(apply(
            Arc::clone(&service),
            params(
                json!({"chatId":"chat","captureSnapshot":false,"operations":[{"type":"update","inputPath":"queued.txt","resolvedPath":file,"hunks":[{"lines":[{"type":"delete","content":"old","ending":"\n"},{"type":"add","content":"new","ending":"\n"}]}]}]}),
            ),
            cancel.clone(),
        ));
        tokio::task::yield_now().await;
        cancel.cancel();
        drop(held);
        assert_eq!(task.await.unwrap().unwrap_err().code, codes::CANCELLED);
        assert_eq!(fs::read_to_string(&file).unwrap(), "old\n");
        assert_eq!(service.state.locks.active_paths(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn revalidation_refuses_a_path_that_a_symlink_switches_outside_policy() {
        use std::os::unix::fs::symlink;

        let (home, service) = fixture();
        let safe = home.join("safe");
        let outside = home.join("outside");
        fs::create_dir_all(&safe).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(safe.join("file.txt"), "old\n").unwrap();
        fs::write(outside.join("file.txt"), "outside\n").unwrap();
        let link = home.join("link");
        symlink(&safe, &link).unwrap();
        let path = link.join("file.txt");
        mark_read(&service, &path);
        let parameters = params(json!({
            "chatId":"chat", "captureSnapshot":false,
            "pathPolicy":{"allowedRoots":[],"deniedRoots":[],"containmentRoot":safe},
            "operations":[{"type":"update","inputPath":"link/file.txt","resolvedPath":path,"hunks":[{"lines":[{"type":"delete","content":"old","ending":"\n"},{"type":"add","content":"new","ending":"\n"}]}]}]
        }));
        let planned = plan_operations(&service, &parameters, &CancellationToken::new()).unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&outside, &link).unwrap();
        let error =
            revalidate_operations(&service, &parameters, &planned, &CancellationToken::new())
                .unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert_eq!(fs::read_to_string(safe.join("file.txt")).unwrap(), "old\n");
    }

    #[cfg(unix)]
    #[test]
    fn final_policy_check_cannot_be_raced_into_an_outside_patch_write() {
        use std::os::unix::fs::symlink;

        let (home, service) = fixture();
        let root = home.join("root");
        let safe = root.join("safe");
        let outside = home.join("outside");
        fs::create_dir_all(&safe).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(safe.join("file.txt"), "old\n").unwrap();
        fs::write(outside.join("file.txt"), "outside\n").unwrap();
        let link = root.join("link");
        symlink(&safe, &link).unwrap();
        let path = link.join("file.txt");
        mark_read(&service, &path);
        let parameters = params(json!({
            "chatId":"chat", "captureSnapshot":false,
            "pathPolicy":{"allowedRoots":[],"deniedRoots":[],"containmentRoot":root},
            "operations":[{"type":"update","inputPath":"link/file.txt","resolvedPath":path,"hunks":[{"lines":[{"type":"delete","content":"old","ending":"\n"},{"type":"add","content":"new","ending":"\n"}]}]}]
        }));
        let cancel = CancellationToken::new();
        let planned = plan_operations(&service, &parameters, &cancel).unwrap();
        let revalidated = revalidate_operations(&service, &parameters, &planned, &cancel).unwrap();
        let hook = SwapAfterFinalPolicyCheck {
            link: link.clone(),
            replacement: outside.clone(),
        };

        let error = commit_revalidated_with_hook(
            &service,
            &parameters,
            &planned,
            &revalidated,
            &cancel,
            &hook,
        )
        .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert_eq!(fs::read_to_string(safe.join("file.txt")).unwrap(), "old\n");
        assert_eq!(
            fs::read_to_string(outside.join("file.txt")).unwrap(),
            "outside\n"
        );
    }

    #[test]
    fn consent_revoked_during_revalidation_refuses_before_the_first_write() {
        let (home, service) = fixture();
        let path = home.join("new.txt");
        let parameters = params(
            json!({"chatId":"chat","captureSnapshot":false,"operations":[{"type":"add","inputPath":"new.txt","resolvedPath":path,"content":"new"}]}),
        );
        let cancel = CancellationToken::new();
        let planned = plan_operations(&service, &parameters, &cancel).unwrap();
        let revalidated = revalidate_operations(&service, &parameters, &planned, &cancel).unwrap();
        crate::runtime_home::write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({"fsWrite":false})))],
        )
        .unwrap();
        let error =
            commit_revalidated(&service, &parameters, &planned, &revalidated, &cancel).unwrap_err();
        assert_eq!(error.code, codes::DENIED);
        assert!(!path.exists());
    }
}
