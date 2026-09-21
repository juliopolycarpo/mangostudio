//! Filesystem handlers, sharing process-wide freshness and mutation locks.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use mango_protocol::session::CallContext;
use mango_protocol::{
    Frame,
    error::{RemoteError, codes},
    frame::Response,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::capability;
use super::freshness::{Ledger, ObservedLineRange, PathLocks, ReadObservation};
use super::io::{self, check_cancel, path_error};
use super::params::*;
use super::policy::{CompiledPolicy, PathPolicy};
use super::text;
use crate::blocking::run_blocking;
use crate::consent::source::ConsentSource;
use crate::ports::audit::lock;
use crate::ports::authorization::consent_denial;
use crate::registry::Registry;

const READ_MAX_BYTES: usize = 10 * 1024 * 1024;
const BYTE_VIEW_MAX_BYTES: usize = 256 * 1024;
const ALL_LINES: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(super) struct State {
    pub(super) ledger: Mutex<Ledger>,
    pub(super) locks: PathLocks,
}

pub(super) struct Service {
    pub(super) state: Arc<State>,
    pub(super) consent: ConsentSource,
    pub(super) move_io: Arc<dyn MoveIo>,
}

pub(super) trait MoveIo: Send + Sync {
    fn move_no_overwrite(
        &self,
        policy: &CompiledPolicy,
        from: &Path,
        to: &Path,
    ) -> Result<(), RemoteError>;
    fn hash_file(&self, policy: &CompiledPolicy, path: &Path) -> Result<String, RemoteError>;
}

pub(super) struct NativeMoveIo;

impl MoveIo for NativeMoveIo {
    fn move_no_overwrite(
        &self,
        policy: &CompiledPolicy,
        from: &Path,
        to: &Path,
    ) -> Result<(), RemoteError> {
        io::move_no_overwrite(policy, from, to)
    }

    fn hash_file(&self, policy: &CompiledPolicy, path: &Path) -> Result<String, RemoteError> {
        io::hash_file(policy, path)
    }
}

#[derive(Clone)]
struct ResponseBudget {
    id: String,
    limit_bytes: usize,
}

impl ResponseBudget {
    fn from_context(context: &CallContext) -> Self {
        Self {
            id: context.id().to_owned(),
            limit_bytes: context.session().send_limit_bytes(),
        }
    }

    #[cfg(test)]
    fn unbounded() -> Self {
        Self {
            id: "test-response".to_owned(),
            limit_bytes: usize::MAX,
        }
    }

    fn preflight_snapshot(&self, mutation: &Mutation, result: &Value) -> Result<(), RemoteError> {
        if !mutation.capture_snapshot {
            return Ok(());
        }
        preflight_response(result, &self.id, self.limit_bytes, "mutation")
    }

    fn preflight_read(&self, result: &Value) -> Result<(), RemoteError> {
        preflight_response(result, &self.id, self.limit_bytes, "read")
    }
}

impl Service {
    fn authorize(&self, method: &str, capture_snapshot: bool) -> Result<(), RemoteError> {
        let allow = self.consent.refresh();
        let capabilities = mangostudio_runtime_contract::catalog::capabilities_of(method)
            .expect("filesystem handler belongs to the catalog");
        let mut required: Vec<&str> = capabilities.iter().map(String::as_str).collect();
        if capture_snapshot {
            for capability in ["fsRead", "checkpoints"] {
                if !required.contains(&capability) {
                    required.push(capability);
                }
            }
        }
        let missing: Vec<String> = required
            .into_iter()
            .filter(|capability| !allow.is_granted(capability))
            .map(str::to_owned)
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        Err(consent_denial(
            method,
            &missing,
            self.consent.slot().as_str(),
        ))
    }

    /// Re-authorizes and binds a mutation's paths to one policy compilation.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let policy = service.compile_mutation_policy("fs.apply-patch", mutation, paths, cancel)?;
    /// io::write_atomic(&policy, path, bytes, false)?;
    /// ```
    pub(super) fn compile_mutation_policy(
        &self,
        method: &str,
        mutation: &Mutation,
        paths: &[&Path],
        cancel: &CancellationToken,
    ) -> Result<CompiledPolicy, RemoteError> {
        self.compile_policy(
            method,
            &mutation.path_policy,
            paths,
            mutation.capture_snapshot,
            cancel,
        )
    }

    fn compile_policy(
        &self,
        method: &str,
        policy: &Option<PathPolicy>,
        paths: &[&Path],
        capture_snapshot: bool,
        cancel: &CancellationToken,
    ) -> Result<CompiledPolicy, RemoteError> {
        check_cancel(cancel)?;
        self.authorize(method, capture_snapshot)?;
        let compiled = policy.clone().unwrap_or_default().compile()?;
        for path in paths {
            compiled.check(path)?;
        }
        Ok(compiled)
    }

    async fn read(
        self: Arc<Self>,
        params: ReadParams,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let guards = self
            .state
            .locks
            .acquire(vec![params.resolved_path.clone()], &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            self.read_sync(params, &response, &cancel)
        })
        .await
    }

    fn read_sync(
        &self,
        params: ReadParams,
        response: &ResponseBudget,
        cancel: &CancellationToken,
    ) -> Result<Value, RemoteError> {
        let policy = self.compile_policy(
            "fs.read-file",
            &params.path_policy,
            &[&params.resolved_path],
            false,
            cancel,
        )?;
        let view = params.view.as_deref().unwrap_or("text");
        let byte_view = view != "text";
        let max = if byte_view {
            BYTE_VIEW_MAX_BYTES
        } else {
            READ_MAX_BYTES
        };
        let observed = io::read(&policy, &params.resolved_path, max, cancel).map_err(|error| {
            if byte_view && error.details.as_ref().is_some_and(|details| details.get("limitBytes").is_some()) {
                return path_error(format!("Cannot read \"{}\" as {view}: a byte view is limited to {BYTE_VIEW_MAX_BYTES} bytes because the whole result reaches the model, and it is not windowed. A text file can be read with view \"text\", which windows by line.", params.input_path))
                    .with_detail("limitBytes", BYTE_VIEW_MAX_BYTES);
            }
            error
        })?;
        if byte_view {
            let content = if view == "hex" {
                hash_hex(&observed.bytes)
            } else {
                base64::engine::general_purpose::STANDARD.encode(&observed.bytes)
            };
            let hash = hash_hex(&Sha256::digest(&observed.bytes));
            let result = json!({"content":content,"path":params.input_path,"size":observed.bytes.len(),"sha256":hash,"totalLines":0,"startLine":1,"endLine":0,"truncated":false,"view":view});
            response.preflight_read(&result)?;
            let recorded_hash = lock(&self.state.ledger).record_read(
                &params.chat_id,
                &params.resolved_path,
                &observed.bytes,
                observed.mtime_ms,
                ReadObservation::ByteView,
            );
            debug_assert_eq!(recorded_hash, hash);
            return Ok(result);
        }
        if text::looks_binary(&observed.bytes) {
            return Err(path_error(format!(
                "\"{}\" appears to be a binary file and cannot be read as text. Read it with view \"hex\" or \"base64\" instead (up to {BYTE_VIEW_MAX_BYTES} bytes).",
                params.input_path
            )));
        }
        let start = positive_integer(params.start_line.unwrap_or(1.0), "startLine")?;
        let maximum = positive_integer(params.max_lines.unwrap_or(2000.0), "maxLines")?;
        let total = text::total_lines(&observed.bytes);
        if start > total.max(1) {
            return Err(path_error(format!(
                "startLine {start} is past the end of \"{}\" ({total} lines).",
                params.input_path
            )));
        }
        let window = if total == 0 {
            text::Window {
                content: String::new(),
                end_line: 0,
                truncated: false,
            }
        } else {
            text::format_window(&observed.bytes, start, maximum)
        };
        let hash = hash_hex(&Sha256::digest(&observed.bytes));
        let result = json!({"content":window.content,"path":params.input_path,"size":observed.bytes.len(),"sha256":hash,"totalLines":total,"startLine":start,"endLine":window.end_line,"truncated":window.truncated});
        response.preflight_read(&result)?;
        let recorded_hash = lock(&self.state.ledger).record_read(
            &params.chat_id,
            &params.resolved_path,
            &observed.bytes,
            observed.mtime_ms,
            ReadObservation::Window(ObservedLineRange {
                start_line: start as u64,
                end_line: window.end_line as u64,
                total_lines: total as u64,
            }),
        );
        debug_assert_eq!(recorded_hash, hash);
        Ok(result)
    }

    async fn write(
        self: Arc<Self>,
        params: WriteParams,
        exclusive: bool,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let guards = self
            .state
            .locks
            .acquire(vec![params.resolved_path.clone()], &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let method = if exclusive {
                "fs.create-file"
            } else {
                "fs.write-file"
            };
            let policy = self.compile_mutation_policy(
                method,
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            let exists = io::path_is_file(&policy, &params.resolved_path)?;
            let before = if exists && !exclusive && params.mutation.capture_snapshot {
                let (size, _) = io::current_metadata(&policy, &params.resolved_path)?;
                snapshot_limit(&params.resolved_path, size as usize)?;
                Some(io::read(&policy, &params.resolved_path, 8 * 1024 * 1024, &cancel)?)
            } else {
                None
            };
            if params.mutation.capture_snapshot {
                snapshot_limit(
                    &params.resolved_path,
                    before.as_ref().map_or(0, |value| value.bytes.len()),
                )?;
            }
            if exists && !exclusive {
                self.assert_current(&policy, &params.mutation.chat_id, &params.resolved_path, &cancel)
                    .map_err(|error| {
                        io::explain_unread(&policy, &params.resolved_path, "overwrite", error)
                    })?;
            }
            let expected_hash = hash_hex(&Sha256::digest(params.content.as_bytes()));
            let mut result =
                json!({"path":params.input_path,"bytesWritten":params.content.len(),"sha256":expected_hash});
            if !exclusive {
                result["created"] = json!(!exists);
            }
            let result = mutation_result(
                result,
                &params.mutation,
                &params.resolved_path,
                if exists { "edit" } else { "create" },
                before.as_ref().map(|observed| observed.bytes.as_slice()),
                &expected_hash,
                None,
            );
            response.preflight_snapshot(&params.mutation, &result)?;
            let policy = self.compile_mutation_policy(
                method,
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            let mtime = if exclusive || !exists {
                io::create_new(&policy, &params.resolved_path, params.content.as_bytes()).map_err(
                    |error| {
                        if error.details.as_ref().is_some_and(|details| {
                            details.get("alreadyExists").and_then(Value::as_bool) == Some(true)
                        }) {
                            return occupied_path(&policy, &params, exclusive);
                        }
                        error
                    },
                )?
            } else {
                io::write_atomic(&policy, &params.resolved_path, params.content.as_bytes(), false)?
            };
            let hash = lock(&self.state.ledger).record_read(
                &params.mutation.chat_id,
                &params.resolved_path,
                params.content.as_bytes(),
                mtime,
                ReadObservation::WholeFile,
            );
            debug_assert_eq!(hash, expected_hash);
            Ok(result)
        })
        .await
    }

    pub(super) fn read_fresh(
        &self,
        policy: &CompiledPolicy,
        chat: &str,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<io::Observed, RemoteError> {
        let entry = lock(&self.state.ledger).complete_entry(chat, path)?;
        let observed = io::read(policy, path, entry.size as usize, cancel).map_err(|error| {
            if error.code == codes::CANCELLED {
                return error;
            }
            super::freshness::stale_file_error(path)
        })?;
        lock(&self.state.ledger).assert_content(chat, path, &observed.bytes)?;
        Ok(observed)
    }

    fn assert_current(
        &self,
        policy: &CompiledPolicy,
        chat: &str,
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<(), RemoteError> {
        lock(&self.state.ledger).complete_entry(chat, path)?;
        if let Ok((size, mtime)) = io::current_metadata(policy, path)
            && lock(&self.state.ledger).matches_metadata(chat, path, size, mtime)?
        {
            return Ok(());
        }
        self.read_fresh(policy, chat, path, cancel).map(|_| ())
    }

    async fn edit(
        self: Arc<Self>,
        params: EditParams,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        if params.old_string.is_empty() {
            return Err(argument(
                "oldString must not be empty. Use create_file for a new file, or provide existing text to replace.",
            ));
        }
        if params.old_string == params.new_string {
            return Err(argument("oldString and newString must be different."));
        }
        let guards = self
            .state
            .locks
            .acquire(vec![params.resolved_path.clone()], &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let policy = self.compile_mutation_policy(
                "fs.edit-file",
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            let observed = self
                .read_fresh(&policy, &params.mutation.chat_id, &params.resolved_path, &cancel)
                .map_err(|error| io::explain_unread(&policy, &params.resolved_path, "edit", error))?;
            let replace_all = params.replace_all.unwrap_or(false);
            let count = text::count_matches_up_to(
                &observed.bytes,
                params.old_string.as_bytes(),
                if replace_all { usize::MAX } else { 2 },
            );
            if count == 0 { return Err(argument(format!("The text to replace was not found in \"{}\". Re-read the file — it may have changed, or adjust oldString to match exactly (including whitespace).", params.input_path))); }
            if count > 1 && !replace_all { return Err(argument(format!("Found at least {count} occurrences. Provide a longer oldString with more surrounding context to make it unique, or set replaceAll: true."))); }
            let replacement_count = if replace_all { count } else { 1 };
            let projected_bytes = if params.new_string.len() >= params.old_string.len() {
                params.new_string.len().checked_sub(params.old_string.len())
                    .and_then(|growth| growth.checked_mul(replacement_count))
                    .and_then(|growth| observed.bytes.len().checked_add(growth))
            } else {
                params.old_string.len().checked_sub(params.new_string.len())
                    .and_then(|shrinkage| shrinkage.checked_mul(replacement_count))
                    .and_then(|shrinkage| observed.bytes.len().checked_sub(shrinkage))
            };
            let Some(projected_bytes) = projected_bytes.filter(|size| *size <= READ_MAX_BYTES) else {
                let received = projected_bytes.map_or_else(|| "an overflowing byte length".to_owned(), |size| format!("{size} bytes"));
                return Err(argument(format!("Cannot edit \"{}\": the replacement would produce {received}; expected at most {READ_MAX_BYTES} bytes so the result remains readable by fs.read-file.", params.input_path)));
            };
            let (updated, replaced, first) = text::replace_matches(&observed.bytes, params.old_string.as_bytes(), params.new_string.as_bytes(), replace_all);
            debug_assert_eq!(updated.len(), projected_bytes);
            debug_assert_eq!(replaced, replacement_count);
            if text::looks_binary(&updated) { return Err(argument(format!("Refusing to edit \"{}\": newString contains a NUL byte, which would make the file unreadable by read_file and leave it unrecoverable by the file tools.",params.input_path))); }
            let expected_hash = hash_hex(&Sha256::digest(&updated));
            let result = mutation_result(json!({"path":params.input_path,"replacements":replaced,"firstChangedLine":first,"sha256":expected_hash}), &params.mutation, &params.resolved_path,"edit",Some(&observed.bytes),&expected_hash,None);
            response.preflight_snapshot(&params.mutation, &result)?;
            let policy = self.compile_mutation_policy(
                "fs.edit-file",
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            let mtime = io::write_atomic(&policy, &params.resolved_path, &updated, false)?;
            let changed_lines = params.old_string.bytes().filter(|byte| *byte == b'\n').count() != params.new_string.bytes().filter(|byte| *byte == b'\n').count();
            let through = if changed_lines { (first - 1) as u64 } else { ALL_LINES };
            let hash = lock(&self.state.ledger).record_edit(&params.mutation.chat_id, &params.resolved_path, &updated, mtime, through);
            debug_assert_eq!(hash, expected_hash);
            Ok(result)
        }).await
    }

    async fn replace_range(
        self: Arc<Self>,
        params: RangeParams,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let guards = self
            .state
            .locks
            .acquire(vec![params.resolved_path.clone()], &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let policy = self.compile_mutation_policy(
                "fs.replace-range",
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            let observed = self
                .read_fresh(&policy, &params.mutation.chat_id, &params.resolved_path, &cancel)
                .map_err(|error| io::explain_unread(&policy, &params.resolved_path, "edit", error))?;
            lock(&self.state.ledger).assert_line_numbers(&params.mutation.chat_id, &params.resolved_path, params.end_line as u64)?;
            let total = text::total_lines(&observed.bytes);
            let start = positive_integer(params.start_line, "startLine")?;
            let end = positive_integer(params.end_line, "endLine")?;
            if start > end || end > total { return Err(argument(format!("Invalid line range {start}-{end} for \"{}\" ({total} lines). Expected 1 <= startLine <= endLine <= {total}.",params.input_path))); }
            let updated = text::replace_range(&observed.bytes,start,end,params.content.as_bytes());
            if text::looks_binary(&updated) { return Err(argument(format!("Refusing to edit \"{}\": content contains a NUL byte, which would make the file unreadable by read_file and leave it unrecoverable by the file tools.",params.input_path))); }
            let expected_hash = hash_hex(&Sha256::digest(&updated));
            let replaced = end-start+1;
            let result = mutation_result(json!({"path":params.input_path,"replacedLines":replaced,"newTotalLines":text::total_lines(&updated),"sha256":expected_hash}),&params.mutation,&params.resolved_path,"edit",Some(&observed.bytes),&expected_hash,None);
            response.preflight_snapshot(&params.mutation, &result)?;
            let policy = self.compile_mutation_policy(
                "fs.replace-range",
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            let mtime = io::write_atomic(&policy, &params.resolved_path, &updated, false)?;
            let through = if text::total_lines(params.content.as_bytes()) == replaced {ALL_LINES} else {(start-1) as u64};
            let hash = lock(&self.state.ledger).record_edit(&params.mutation.chat_id, &params.resolved_path, &updated, mtime, through);
            debug_assert_eq!(hash, expected_hash);
            Ok(result)
        }).await
    }

    async fn delete(
        self: Arc<Self>,
        params: DeleteParams,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        let guards = self
            .state
            .locks
            .acquire(vec![params.resolved_path.clone()], &cancel)
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let policy = self.compile_mutation_policy(
                "fs.delete-file",
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            io::assert_regular(&policy, &params.resolved_path, "delete")?;
            let before = if params.mutation.capture_snapshot {
                Some(
                    self.read_fresh(
                        &policy,
                        &params.mutation.chat_id,
                        &params.resolved_path,
                        &cancel,
                    )
                    .map_err(|error| {
                        io::explain_unread(&policy, &params.resolved_path, "delete", error)
                    })?,
                )
            } else {
                self.assert_current(
                    &policy,
                    &params.mutation.chat_id,
                    &params.resolved_path,
                    &cancel,
                )
                .map_err(|error| {
                    io::explain_unread(&policy, &params.resolved_path, "delete", error)
                })?;
                None
            };
            let result = mutation_result(
                json!({"path":params.input_path,"deleted":true}),
                &params.mutation,
                &params.resolved_path,
                "delete",
                before.as_ref().map(|observed| observed.bytes.as_slice()),
                "absent",
                None,
            );
            response.preflight_snapshot(&params.mutation, &result)?;
            let policy = self.compile_mutation_policy(
                "fs.delete-file",
                &params.mutation,
                &[&params.resolved_path],
                &cancel,
            )?;
            io::delete_file(&policy, &params.resolved_path).map_err(|error| {
                if error.details.as_ref().is_some_and(|details| {
                    details.get("notFound").and_then(Value::as_bool) == Some(true)
                }) {
                    return super::freshness::stale_file_error(&params.resolved_path);
                }
                error
            })?;
            lock(&self.state.ledger).forget(&params.mutation.chat_id, &params.resolved_path);
            Ok(result)
        })
        .await
    }

    async fn move_file(
        self: Arc<Self>,
        params: MoveParams,
        response: ResponseBudget,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        if params.resolved_from == params.resolved_to {
            return Err(path_error(
                "Source and destination must be different paths.",
            ));
        }
        let guards = self
            .state
            .locks
            .acquire(
                vec![params.resolved_from.clone(), params.resolved_to.clone()],
                &cancel,
            )
            .await
            .map_err(lock_error)?;
        run_blocking(move || {
            let _guards = guards;
            let policy = self.compile_mutation_policy(
                "fs.move-file",
                &params.mutation,
                &[&params.resolved_from, &params.resolved_to],
                &cancel,
            )?;
            let metadata = io::assert_regular(&policy, &params.resolved_from, "move")?;
            let before = if params.mutation.capture_snapshot {
                snapshot_limit(&params.resolved_from, metadata.len as usize)?;
                Some(io::read(
                    &policy,
                    &params.resolved_from,
                    8 * 1024 * 1024,
                    &cancel,
                )?)
            } else {
                None
            };
            let expected_hash = before.as_ref().map_or_else(
                || io::hash_file(&policy, &params.resolved_from),
                |observed| Ok(hash_hex(&Sha256::digest(&observed.bytes))),
            )?;
            let result = mutation_result(
                json!({"from":params.input_from,"to":params.input_to,"moved":true}),
                &params.mutation,
                &params.resolved_from,
                "move",
                before.as_ref().map(|observed| observed.bytes.as_slice()),
                &expected_hash,
                Some(&params.resolved_to),
            );
            response.preflight_snapshot(&params.mutation, &result)?;
            let policy = self.compile_mutation_policy(
                "fs.move-file",
                &params.mutation,
                &[&params.resolved_from, &params.resolved_to],
                &cancel,
            )?;
            self.move_io
                .move_no_overwrite(&policy, &params.resolved_from, &params.resolved_to)?;
            let committed_hash = match self.move_io.hash_file(&policy, &params.resolved_to) {
                Ok(hash) => hash,
                Err(cause) => {
                    let mut ledger = lock(&self.state.ledger);
                    ledger.forget(&params.mutation.chat_id, &params.resolved_from);
                    ledger.forget(&params.mutation.chat_id, &params.resolved_to);
                    return Err(committed_move_error(
                        &params.resolved_from,
                        &params.resolved_to,
                        cause,
                    ));
                }
            };
            let mut ledger = lock(&self.state.ledger);
            if committed_hash == expected_hash {
                ledger.rekey(
                    &params.mutation.chat_id,
                    &params.resolved_from,
                    &params.resolved_to,
                );
            } else {
                ledger.forget(&params.mutation.chat_id, &params.resolved_from);
                ledger.forget(&params.mutation.chat_id, &params.resolved_to);
            }
            drop(ledger);
            Ok(mutation_result(
                json!({"from":params.input_from,"to":params.input_to,"moved":true}),
                &params.mutation,
                &params.resolved_from,
                "move",
                before.as_ref().map(|observed| observed.bytes.as_slice()),
                &committed_hash,
                Some(&params.resolved_to),
            ))
        })
        .await
    }

    async fn list(
        self: Arc<Self>,
        params: ListParams,
        cancel: CancellationToken,
    ) -> Result<Value, RemoteError> {
        run_blocking(move || {
            let policy = self.compile_policy(
                "fs.list-directory",
                &params.path_policy,
                &[&params.resolved_path],
                false,
                &cancel,
            )?;
            let list_error = |error: std::io::Error| {
                path_error(format!("Cannot list \"{}\": {error}", params.input_path))
            };
            let entries = if policy.is_unrestricted() {
                list_unrestricted(&params.resolved_path, &cancel, &list_error)?
            } else {
                list_bound(&policy, &params.resolved_path, &cancel, &list_error)?
            };
            Ok(json!({"path":params.input_path,"entries":entries}))
        })
        .await
    }
}

fn list_unrestricted(
    path: &Path,
    cancel: &CancellationToken,
    list_error: &impl Fn(std::io::Error) -> RemoteError,
) -> Result<Vec<Value>, RemoteError> {
    std::fs::read_dir(path)
        .map_err(list_error)?
        .map(|entry| {
            check_cancel(cancel)?;
            let entry = entry.map_err(list_error)?;
            let kind = if entry.file_type().map_err(list_error)?.is_dir() {
                "directory"
            } else {
                "file"
            };
            Ok(json!({"name":entry.file_name().to_string_lossy(),"type":kind}))
        })
        .collect()
}

fn list_bound(
    policy: &CompiledPolicy,
    path: &Path,
    cancel: &CancellationToken,
    list_error: &impl Fn(std::io::Error) -> RemoteError,
) -> Result<Vec<Value>, RemoteError> {
    let directory = capability::open_directory(policy, path).map_err(|error| {
        list_error(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            error.message,
        ))
    })?;
    directory.with_dir(|dir| {
        dir.entries()
            .map_err(list_error)?
            .map(|entry| {
                check_cancel(cancel)?;
                let entry = entry.map_err(list_error)?;
                let kind = if entry.file_type().map_err(list_error)?.is_dir() {
                    "directory"
                } else {
                    "file"
                };
                Ok(json!({"name":entry.file_name().to_string_lossy(),"type":kind}))
            })
            .collect()
    })
}

fn occupied_path(policy: &CompiledPolicy, params: &WriteParams, create: bool) -> RemoteError {
    if !create {
        if io::assert_regular(policy, &params.resolved_path, "write").is_ok() {
            return io::explain_unread(
                policy,
                &params.resolved_path,
                "overwrite",
                super::freshness::file_not_read_error(&params.resolved_path),
            );
        }
        return path_error(format!(
            "Cannot write \"{}\": the path exists and is not a regular file.",
            params.resolved_path.display()
        ));
    }
    io::create_conflict_error(policy, &params.resolved_path, &params.input_path)
}

pub(super) fn argument(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "tool_argument")
}

pub(super) fn snapshot_limit(path: &Path, size: usize) -> Result<(), RemoteError> {
    const MAX: usize = 8 * 1024 * 1024;
    if size <= MAX {
        return Ok(());
    }
    Err(RemoteError::new(
        codes::INTERNAL,
        format!(
            "Cannot checkpoint \"{}\": it is {size} bytes, past the {MAX}-byte snapshot limit.",
            path.display()
        ),
    )
    .with_detail("kind", "snapshot_too_large")
    .with_detail("resolvedPath", path.to_string_lossy().as_ref())
    .with_detail("sizeBytes", size))
}

pub(super) fn lock_error(_: super::freshness::PathLockError) -> RemoteError {
    RemoteError::new(codes::CANCELLED, "Filesystem operation cancelled")
}

fn committed_move_error(from: &Path, to: &Path, cause: RemoteError) -> RemoteError {
    path_error(format!(
        "Move committed, but the destination hash could not be verified. Inspect \"{}\" and \"{}\" before retrying. Cause: {}",
        from.display(),
        to.display(),
        cause.message
    ))
    .with_detail("changedPaths", json!([from, to]))
}

fn positive_integer(value: f64, name: &str) -> Result<usize, RemoteError> {
    if value < 1.0 || value.fract() != 0.0 || value > ALL_LINES as f64 {
        return Err(argument(format!(
            "Invalid {name} {value}. Expected a positive safe integer."
        )));
    }
    Ok(value as usize)
}

fn hash_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn preflight_response(
    result: &Value,
    response_id: &str,
    response_limit_bytes: usize,
    subject: &str,
) -> Result<(), RemoteError> {
    let frame = Frame::Res(Response {
        id: response_id.to_owned(),
        result: result.clone(),
    });
    let size = serde_json::to_vec(&frame)
        .expect("a filesystem mutation response always serializes")
        .len();
    if size <= response_limit_bytes {
        return Ok(());
    }
    let guidance = if subject == "read" {
        "Read a smaller text window or choose a more compact view."
    } else {
        "Split the operation into smaller calls or disable snapshot capture."
    };
    Err(RemoteError::new(
        codes::FRAME_TOO_LARGE,
        format!(
            "Cannot return {subject} response: it is {size} bytes, but the negotiated frame limit is {response_limit_bytes} bytes. {guidance}"
        ),
    )
    .with_detail("kind", "snapshot_too_large")
    .with_detail("sizeBytes", size)
    .with_detail("limitBytes", response_limit_bytes))
}

pub(super) fn mutation_result(
    result: Value,
    params: &Mutation,
    path: &Path,
    op: &str,
    before: Option<&[u8]>,
    hash: &str,
    moved_to: Option<&Path>,
) -> Value {
    if !params.capture_snapshot {
        return json!({"result":result,"mutations":[]});
    }
    let before = before.map_or_else(||json!({"exists":false}),|bytes|json!({"exists":true,"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"hash":hash_hex(&Sha256::digest(bytes))}));
    let mut snapshot = json!({"path":path,"op":op,"before":before,"afterHash":hash});
    if let Some(to) = moved_to {
        snapshot["movedTo"] = json!(to);
    }
    json!({"result":result,"mutations":[snapshot]})
}

pub(crate) fn register(registry: Registry, consent: ConsentSource) -> Registry {
    static STATE: OnceLock<Arc<State>> = OnceLock::new();
    let service = Arc::new(Service {
        state: Arc::clone(STATE.get_or_init(|| Arc::new(State::default()))),
        consent,
        move_io: Arc::new(NativeMoveIo),
    });
    let read = Arc::clone(&service);
    let write = Arc::clone(&service);
    let create = Arc::clone(&service);
    let edit = Arc::clone(&service);
    let range = Arc::clone(&service);
    let delete = Arc::clone(&service);
    let move_file = Arc::clone(&service);
    let list = Arc::clone(&service);
    let glob = Arc::clone(&service);
    let grep = Arc::clone(&service);
    registry
        .implement("fs.read-file", move |params, ctx: CallContext| {
            let response = ResponseBudget::from_context(&ctx);
            Arc::clone(&read).read(params, response, ctx.cancel().clone())
        })
        .implement("fs.write-file", move |params, ctx: CallContext| {
            let response = ResponseBudget::from_context(&ctx);
            Arc::clone(&write).write(params, false, response, ctx.cancel().clone())
        })
        .implement("fs.create-file", move |params, ctx: CallContext| {
            let response = ResponseBudget::from_context(&ctx);
            Arc::clone(&create).write(params, true, response, ctx.cancel().clone())
        })
        .implement("fs.edit-file", move |params, ctx: CallContext| {
            let response = ResponseBudget::from_context(&ctx);
            Arc::clone(&edit).edit(params, response, ctx.cancel().clone())
        })
        .implement("fs.replace-range", move |params, ctx: CallContext| {
            let response = ResponseBudget::from_context(&ctx);
            Arc::clone(&range).replace_range(params, response, ctx.cancel().clone())
        })
        .implement("fs.delete-file", move |params, ctx: CallContext| {
            let response = ResponseBudget::from_context(&ctx);
            Arc::clone(&delete).delete(params, response, ctx.cancel().clone())
        })
        .implement("fs.move-file", move |params, ctx: CallContext| {
            let response = ResponseBudget::from_context(&ctx);
            Arc::clone(&move_file).move_file(params, response, ctx.cancel().clone())
        })
        .implement("fs.list-directory", move |params, ctx: CallContext| {
            Arc::clone(&list).list(params, ctx.cancel().clone())
        })
        .implement(
            "fs.glob",
            move |params: super::search::GlobParams, ctx: CallContext| {
                let service = Arc::clone(&glob);
                let cancel = ctx.cancel().clone();
                run_blocking(move || {
                    check_cancel(&cancel)?;
                    service.authorize("fs.glob", false)?;
                    super::search::glob(params, &cancel)
                })
            },
        )
        .implement(
            "fs.grep",
            move |params: super::search::GrepParams, ctx: CallContext| {
                let service = Arc::clone(&grep);
                let cancel = ctx.cancel().clone();
                run_blocking(move || {
                    check_cancel(&cancel)?;
                    service.authorize("fs.grep", false)?;
                    super::search::grep(params, &cancel)
                })
            },
        )
        .implement("fs.apply-patch", move |params, ctx: CallContext| {
            let response_id = ctx.id().to_string();
            let response_limit_bytes = ctx.session().send_limit_bytes();
            super::patch_apply::apply(
                Arc::clone(&service),
                params,
                ctx.cancel().clone(),
                response_id,
                response_limit_bytes,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_home::RuntimeSlot;
    use crate::test_support::{ScratchDir, scratch_dir};

    fn fixture() -> (ScratchDir, Arc<Service>) {
        fixture_with_move_io(Arc::new(NativeMoveIo))
    }

    fn fixture_with_move_io(move_io: Arc<dyn MoveIo>) -> (ScratchDir, Arc<Service>) {
        let home = scratch_dir("filesystem-service");
        let service = Arc::new(Service {
            state: Arc::new(State::default()),
            consent: ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()),
            move_io,
        });
        (home, service)
    }

    struct ReplacingMoveIo {
        replacement: Vec<u8>,
    }

    impl MoveIo for ReplacingMoveIo {
        fn move_no_overwrite(
            &self,
            policy: &CompiledPolicy,
            from: &Path,
            to: &Path,
        ) -> Result<(), RemoteError> {
            std::fs::write(from, &self.replacement).map_err(io::io_error)?;
            io::move_no_overwrite(policy, from, to)
        }

        fn hash_file(&self, policy: &CompiledPolicy, path: &Path) -> Result<String, RemoteError> {
            io::hash_file(policy, path)
        }
    }

    struct FailingHashMoveIo;

    impl MoveIo for FailingHashMoveIo {
        fn move_no_overwrite(
            &self,
            policy: &CompiledPolicy,
            from: &Path,
            to: &Path,
        ) -> Result<(), RemoteError> {
            io::move_no_overwrite(policy, from, to)
        }

        fn hash_file(&self, _: &CompiledPolicy, path: &Path) -> Result<String, RemoteError> {
            Err(path_error(format!(
                "Cannot hash \"{}\": injected failure.",
                path.display()
            )))
        }
    }

    fn decode<T: serde::de::DeserializeOwned>(value: Value) -> T {
        serde_json::from_value(value).unwrap()
    }

    fn read_params(path: &Path) -> ReadParams {
        decode(json!({"chatId":"chat","inputPath":"file","resolvedPath":path}))
    }

    fn write_params(path: &Path, content: &str) -> WriteParams {
        decode(
            json!({"chatId":"chat","inputPath":"file","resolvedPath":path,"content":content,"captureSnapshot":true}),
        )
    }

    fn constrained_response() -> ResponseBudget {
        ResponseBudget {
            id: "response".to_owned(),
            limit_bytes: 4096,
        }
    }

    async fn seed_and_read(service: &Arc<Service>, path: &Path, content: &[u8]) {
        std::fs::write(path, content).unwrap();
        Arc::clone(service)
            .read(
                read_params(path),
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
    }

    fn assert_snapshot_frame_error(error: RemoteError) {
        assert_eq!(error.code, codes::FRAME_TOO_LARGE);
        assert_eq!(error.details.unwrap()["kind"], "snapshot_too_large");
    }

    fn assert_schema(method: &str, result: &Value) {
        let schema = &mangostudio_runtime_contract::catalog::method(method)
            .unwrap()
            .result;
        assert!(
            crate::result_check::compile_result_schema(schema).is_valid(result),
            "{method}: {result}"
        );
    }

    #[tokio::test]
    async fn basic_file_cycle_returns_catalog_valid_results_and_snapshots() {
        let (home, service) = fixture();
        let path = home.join("file");
        let cancel = CancellationToken::new();
        let created = Arc::clone(&service)
            .write(
                write_params(&path, "one\ntwo\n"),
                true,
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap();
        assert_schema("fs.create-file", &created);
        assert_eq!(created["mutations"][0]["before"], json!({"exists":false}));
        let read = Arc::clone(&service)
            .read(
                read_params(&path),
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap();
        assert_schema("fs.read-file", &read);
        assert_eq!(read["content"], "     1\tone\n     2\ttwo");
        let edited=Arc::clone(&service).edit(decode(json!({"chatId":"chat","inputPath":"file","resolvedPath":path,"oldString":"one","newString":"first","captureSnapshot":true})),ResponseBudget::unbounded(),cancel.clone()).await.unwrap();
        assert_schema("fs.edit-file", &edited);
        assert_eq!(edited["result"]["firstChangedLine"], 1);
        let replaced=Arc::clone(&service).replace_range(decode(json!({"chatId":"chat","inputPath":"file","resolvedPath":path,"startLine":2,"endLine":2,"content":"second","captureSnapshot":true})),ResponseBudget::unbounded(),cancel.clone()).await.unwrap();
        assert_schema("fs.replace-range", &replaced);
        assert_eq!(std::fs::read(&path).unwrap(), b"first\nsecond\n");
        let written = Arc::clone(&service)
            .write(
                write_params(&path, "whole"),
                false,
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap();
        assert_schema("fs.write-file", &written);
        assert_eq!(written["result"]["created"], false);
        let listed = Arc::clone(&service)
            .list(
                decode(json!({"inputPath":".","resolvedPath":home.to_path_buf()})),
                cancel.clone(),
            )
            .await
            .unwrap();
        assert_schema("fs.list-directory", &listed);
        assert_eq!(listed["entries"], json!([{"name":"file","type":"file"}]));
        let to = home.join("moved");
        let moved=Arc::clone(&service).move_file(decode(json!({"chatId":"chat","captureSnapshot":true,"inputFrom":"file","inputTo":"moved","resolvedFrom":path,"resolvedTo":to})),ResponseBudget::unbounded(),cancel.clone()).await.unwrap();
        assert_schema("fs.move-file", &moved);
        let deleted=Arc::clone(&service).delete(decode(json!({"chatId":"chat","captureSnapshot":true,"inputPath":"moved","resolvedPath":to})),ResponseBudget::unbounded(),cancel).await.unwrap();
        assert_schema("fs.delete-file", &deleted);
        assert!(!to.exists());
        assert_eq!(deleted["mutations"][0]["afterHash"], "absent");
        assert_eq!(service.state.locks.active_paths(), 0);
    }

    #[tokio::test]
    async fn edit_refuses_an_expansion_larger_than_the_read_limit_before_replacing() {
        let (home, service) = fixture();
        let path = home.join("large-edit");
        let source = "a".repeat(1_000_000);
        seed_and_read(&service, &path, source.as_bytes()).await;

        let error = Arc::clone(&service)
            .edit(
                decode(json!({
                    "chatId": "chat", "captureSnapshot": false,
                    "inputPath": "large-edit", "resolvedPath": path,
                    "oldString": "a", "newString": "01234567890", "replaceAll": true
                })),
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "tool_argument");
        assert!(error.message.contains("would produce 11000000 bytes"));
        assert_eq!(std::fs::read(&path).unwrap(), source.as_bytes());
    }

    #[tokio::test]
    async fn oversized_snapshot_responses_refuse_every_mutation_before_commit() {
        let (home, service) = fixture();
        let original = format!("{}needle", "a".repeat(4096));

        let write_path = home.join("write");
        seed_and_read(&service, &write_path, original.as_bytes()).await;
        let error = Arc::clone(&service)
            .write(
                write_params(&write_path, "replacement"),
                false,
                constrained_response(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_snapshot_frame_error(error);
        assert_eq!(std::fs::read_to_string(&write_path).unwrap(), original);

        let edit_path = home.join("edit");
        seed_and_read(&service, &edit_path, original.as_bytes()).await;
        let error = Arc::clone(&service)
            .edit(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":true,
                    "inputPath":"edit", "resolvedPath":edit_path,
                    "oldString":"needle", "newString":"thread"
                })),
                constrained_response(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_snapshot_frame_error(error);
        assert_eq!(std::fs::read_to_string(&edit_path).unwrap(), original);

        let range_path = home.join("range");
        seed_and_read(&service, &range_path, original.as_bytes()).await;
        let error = Arc::clone(&service)
            .replace_range(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":true,
                    "inputPath":"range", "resolvedPath":range_path,
                    "startLine":1, "endLine":1, "content":"replacement"
                })),
                constrained_response(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_snapshot_frame_error(error);
        assert_eq!(std::fs::read_to_string(&range_path).unwrap(), original);

        let delete_path = home.join("delete");
        seed_and_read(&service, &delete_path, original.as_bytes()).await;
        let error = Arc::clone(&service)
            .delete(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":true,
                    "inputPath":"delete", "resolvedPath":delete_path
                })),
                constrained_response(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_snapshot_frame_error(error);
        assert_eq!(std::fs::read_to_string(&delete_path).unwrap(), original);

        let move_path = home.join("move");
        let move_to = home.join("moved");
        seed_and_read(&service, &move_path, original.as_bytes()).await;
        let error = Arc::clone(&service)
            .move_file(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":true,
                    "inputFrom":"move", "inputTo":"moved",
                    "resolvedFrom":move_path, "resolvedTo":move_to
                })),
                constrained_response(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_snapshot_frame_error(error);
        assert_eq!(std::fs::read_to_string(&move_path).unwrap(), original);
        assert!(!move_to.exists());
    }

    #[tokio::test]
    async fn oversized_read_responses_do_not_grant_freshness() {
        let (home, service) = fixture();
        for (name, view, content) in [
            ("text", None, "a\n".repeat(2_000).into_bytes()),
            ("bytes", Some("base64"), vec![b'a'; 4_096]),
        ] {
            let path = home.join(name);
            std::fs::write(&path, &content).unwrap();
            let mut params = read_params(&path);
            params.input_path = name.to_owned();
            params.view = view.map(str::to_owned);

            let error = Arc::clone(&service)
                .read(params, constrained_response(), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.code, codes::FRAME_TOO_LARGE);

            let mut write = write_params(&path, "replacement");
            write.input_path = name.to_owned();
            let error = Arc::clone(&service)
                .write(
                    write,
                    false,
                    ResponseBudget::unbounded(),
                    CancellationToken::new(),
                )
                .await
                .unwrap_err();
            assert_eq!(error.details.unwrap()["kind"], "file_not_read");
            assert_eq!(std::fs::read(&path).unwrap(), content);
        }
        assert!(lock(&service.state.ledger).is_empty());
    }

    #[tokio::test]
    async fn read_waits_for_the_path_lock_before_recording_freshness() {
        let (home, service) = fixture();
        let path = home.join("file");
        std::fs::write(&path, b"old\n").unwrap();
        let held = service
            .state
            .locks
            .acquire(vec![path.clone()], &CancellationToken::new())
            .await
            .unwrap();
        let pending_service = Arc::clone(&service);
        let pending_path = path.clone();
        let pending = tokio::spawn(async move {
            pending_service
                .read(
                    read_params(&pending_path),
                    ResponseBudget::unbounded(),
                    CancellationToken::new(),
                )
                .await
        });
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());

        std::fs::write(&path, b"new\n").unwrap();
        drop(held);
        let result = pending.await.unwrap().unwrap();
        assert_eq!(result["content"], "     1\tnew");

        Arc::clone(&service)
            .write(
                write_params(&path, "replacement"),
                false,
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
    }

    #[tokio::test]
    async fn move_snapshot_uses_the_committed_destination_hash() {
        let replacement = b"external\n".to_vec();
        let (home, service) = fixture_with_move_io(Arc::new(ReplacingMoveIo {
            replacement: replacement.clone(),
        }));
        let source = home.join("source");
        let destination = home.join("destination");
        seed_and_read(&service, &source, b"original\n").await;

        let result = Arc::clone(&service)
            .move_file(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":true,
                    "inputFrom":"source", "inputTo":"destination",
                    "resolvedFrom":source, "resolvedTo":destination
                })),
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        let committed_hash = hash_hex(&Sha256::digest(&replacement));
        assert_eq!(std::fs::read(&destination).unwrap(), replacement);
        assert_eq!(result["mutations"][0]["afterHash"], committed_hash);
        assert!(lock(&service.state.ledger).is_empty());
    }

    #[tokio::test]
    async fn failed_post_move_hash_reports_changed_paths_and_forgets_freshness() {
        let (home, service) = fixture_with_move_io(Arc::new(FailingHashMoveIo));
        let source = home.join("source");
        let destination = home.join("destination");
        seed_and_read(&service, &source, b"original\n").await;

        let error = Arc::clone(&service)
            .move_file(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":true,
                    "inputFrom":"source", "inputTo":"destination",
                    "resolvedFrom":source, "resolvedTo":destination
                })),
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();

        assert!(error.message.starts_with("Move committed, but"));
        assert_eq!(
            error.details.unwrap()["changedPaths"],
            json!([source, destination])
        );
        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"original\n");
        assert!(lock(&service.state.ledger).is_empty());
    }

    #[tokio::test]
    async fn partial_reads_and_external_changes_refuse_overwrite() {
        let (home, service) = fixture();
        let path = home.join("file");
        std::fs::write(&path, b"one\ntwo\n").unwrap();
        let cancel = CancellationToken::new();
        let unread = Arc::clone(&service)
            .write(
                write_params(&path, "oops"),
                false,
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(unread.details.unwrap()["kind"], "file_not_read");
        let mut params = read_params(&path);
        params.max_lines = Some(1.0);
        Arc::clone(&service)
            .read(params, ResponseBudget::unbounded(), cancel.clone())
            .await
            .unwrap();
        let partial = Arc::clone(&service)
            .write(
                write_params(&path, "oops"),
                false,
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(partial.details.unwrap()["kind"], "partial_read");
        Arc::clone(&service)
            .read(
                read_params(&path),
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap();
        std::fs::write(&path, b"external").unwrap();
        let stale = Arc::clone(&service)
            .write(
                write_params(&path, "oops"),
                false,
                ResponseBudget::unbounded(),
                cancel,
            )
            .await
            .unwrap_err();
        assert_eq!(stale.details.unwrap()["kind"], "stale_file");
        assert_eq!(std::fs::read(&path).unwrap(), b"external");
    }

    #[tokio::test]
    async fn byte_view_allows_overwrite_but_never_invents_line_numbers() {
        let (home, service) = fixture();
        let path = home.join("file");
        std::fs::write(&path, b"\0abc").unwrap();
        let cancel = CancellationToken::new();
        let binary = Arc::clone(&service)
            .read(
                read_params(&path),
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(binary.details.unwrap()["kind"], "path_access");
        let mut params = read_params(&path);
        params.view = Some("hex".into());
        let read = Arc::clone(&service)
            .read(params, ResponseBudget::unbounded(), cancel.clone())
            .await
            .unwrap();
        assert_eq!(read["content"], "00616263");
        let error=Arc::clone(&service).replace_range(decode(json!({"chatId":"chat","inputPath":"file","resolvedPath":path,"startLine":1,"endLine":1,"content":"text","captureSnapshot":false})),ResponseBudget::unbounded(),cancel.clone()).await.unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "unobserved_line_numbers");
        Arc::clone(&service)
            .write(
                write_params(&path, "text"),
                false,
                ResponseBudget::unbounded(),
                cancel,
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"text");
    }

    #[tokio::test]
    async fn cancellation_and_policy_refuse_before_creation() {
        let (home, service) = fixture();
        let path = home.join("file");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = Arc::clone(&service)
            .write(
                write_params(&path, "oops"),
                true,
                ResponseBudget::unbounded(),
                cancel,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::CANCELLED);
        let mut params = write_params(&path, "oops");
        params.mutation.path_policy = Some(PathPolicy {
            allowed_roots: vec![home.join("other")],
            ..PathPolicy::default()
        });
        let error = Arc::clone(&service)
            .write(
                params,
                true,
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "path_access");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn occupied_create_and_missing_list_report_path_access_errors() {
        let (home, service) = fixture();
        let path = home.join("file");
        std::fs::write(&path, "existing").unwrap();
        let error = Arc::clone(&service)
            .write(
                write_params(&path, "oops"),
                true,
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.details.as_ref().and_then(|d| d.get("kind")),
            Some(&json!("path_access"))
        );
        assert_eq!(
            error.message,
            "\"file\" already exists. Read it with read_file, then use edit_file for an exact text change, replace_range for a line change, or write_file to replace all content."
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), "existing");
        let error = Arc::clone(&service)
            .list(
                decode(json!({"inputPath":"missing","resolvedPath":home.join("missing")})),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.details.as_ref().and_then(|d| d.get("kind")),
            Some(&json!("path_access"))
        );
        assert!(error.message.starts_with("Cannot list \"missing\": "));

        let error = service
            .list(
                decode(json!({
                    "inputPath":"missing",
                    "resolvedPath":home.join("missing"),
                    "pathPolicy":{
                        "allowedRoots":[home.to_path_buf()],
                        "deniedRoots":[],
                        "containmentRoot":null
                    }
                })),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("kind")),
            Some(&json!("path_access"))
        );
        assert!(error.message.starts_with("Cannot list \"missing\": "));
    }

    #[tokio::test]
    async fn oversized_byte_view_names_its_bound_and_does_not_grant_freshness() {
        let (home, service) = fixture();
        let path = home.join("file");
        std::fs::File::create(&path)
            .unwrap()
            .set_len((BYTE_VIEW_MAX_BYTES + 1) as u64)
            .unwrap();
        let mut params = read_params(&path);
        params.view = Some("base64".into());
        let error = Arc::clone(&service)
            .read(
                params,
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            format!(
                "Cannot read \"file\" as base64: a byte view is limited to {BYTE_VIEW_MAX_BYTES} bytes because the whole result reaches the model, and it is not windowed. A text file can be read with view \"text\", which windows by line."
            )
        );
        assert_eq!(error.details.unwrap()["limitBytes"], BYTE_VIEW_MAX_BYTES);
        assert!(lock(&service.state.ledger).is_empty());
    }

    #[tokio::test]
    async fn delete_without_snapshot_returns_no_mutations_and_forgets_freshness() {
        let (home, service) = fixture();
        let path = home.join("file");
        let cancel = CancellationToken::new();
        Arc::clone(&service)
            .write(
                write_params(&path, "delete me"),
                true,
                ResponseBudget::unbounded(),
                cancel.clone(),
            )
            .await
            .unwrap();
        let result = Arc::clone(&service).delete(decode(json!({"chatId":"chat","captureSnapshot":false,"inputPath":"file","resolvedPath":path})), ResponseBudget::unbounded(), cancel).await.unwrap();
        assert_schema("fs.delete-file", &result);
        assert_eq!(result["mutations"], json!([]));
        assert!(!path.exists());
        assert!(lock(&service.state.ledger).is_empty());
    }

    #[test]
    fn registration_covers_the_basic_methods_and_numeric_bounds_refuse_bad_values() {
        let home = scratch_dir("filesystem-registration");
        let registry = register(
            Registry::new(),
            ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()),
        );
        assert_eq!(registry.implemented_methods().len(), 11);
        assert!(positive_integer(0.0, "startLine").is_err());
        assert!(positive_integer(1.5, "startLine").is_err());
        assert_eq!(positive_integer(2.0, "startLine").unwrap(), 2);
    }

    #[tokio::test]
    async fn queued_write_rechecks_consent_after_acquiring_its_path_lock() {
        let (home, service) = fixture();
        let path = home.join("file");
        let cancel = CancellationToken::new();
        service.authorize("fs.create-file", false).unwrap();
        let guard = service
            .state
            .locks
            .acquire(vec![path.clone()], &cancel)
            .await
            .unwrap();
        let pending = Arc::clone(&service).write(
            write_params(&path, "refused"),
            true,
            ResponseBudget::unbounded(),
            cancel,
        );
        tokio::pin!(pending);
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(
                pending.as_mut().poll(cx).is_pending()
            ))
            .await
        );
        crate::runtime_home::write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[("allow", Some(json!({"fsWrite":false})))],
        )
        .unwrap();
        drop(guard);
        let error = pending.await.unwrap_err();
        assert_eq!(error.code, codes::DENIED);
        assert!(!path.exists());
        assert_eq!(service.state.locks.active_paths(), 0);
    }

    #[tokio::test]
    async fn move_snapshot_requires_read_and_checkpoint_consent() {
        let (home, service) = fixture();
        let source = home.join("source");
        let destination = home.join("destination");
        std::fs::write(&source, b"private").unwrap();
        crate::runtime_home::write_runtime_slot_config(
            RuntimeSlot::Host,
            &home,
            &[(
                "allow",
                Some(json!({"fsWrite":true,"fsRead":false,"checkpoints":false})),
            )],
        )
        .unwrap();

        let error = Arc::clone(&service)
            .move_file(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":true,
                    "inputFrom":"source", "inputTo":"destination",
                    "resolvedFrom":source, "resolvedTo":destination
                })),
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, codes::DENIED);
        assert_eq!(
            error.details.unwrap()["missing"],
            json!(["fsRead", "checkpoints"])
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"private");
        assert!(!destination.exists());

        let moved = Arc::clone(&service)
            .move_file(
                decode(json!({
                    "chatId":"chat", "captureSnapshot":false,
                    "inputFrom":"source", "inputTo":"destination",
                    "resolvedFrom":source, "resolvedTo":destination
                })),
                ResponseBudget::unbounded(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(moved["mutations"], json!([]));
        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"private");
    }
}
