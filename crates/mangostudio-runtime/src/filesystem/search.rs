//! Synchronous, bounded glob and grep operations for the runtime filesystem.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use globset::GlobBuilder;
use mango_protocol::error::{RemoteError, codes};
use rquickjs::{CatchResultExt, Context, Runtime};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use cap_fs_ext::DirExt as _;

use super::capability::{
    BoundDir, bind_opened_directory, open_directory_if_present, open_existing_file,
    verify_opened_file,
};
use super::io::{check_cancel, io_error, path_error, read};
use super::policy::{CompiledPolicy, PathPolicy};
use crate::workspace::lexically_normalize;

const MAX_PATTERN_UTF16_UNITS: usize = 1_000;
const MAX_CANDIDATES: usize = 100_000;
const GREP_FILE_BUDGET: Duration = Duration::from_secs(2);
const QUICKJS_RUNTIME_BYTES: usize = 4 * 1024 * 1024;
const QUICKJS_INPUT_MULTIPLIER: usize = 8;

/// Parameters for the `fs.glob` contract method.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GlobParams {
    pub pattern: String,
    pub cwd: PathBuf,
    #[serde(deserialize_with = "deserialize_count")]
    pub max_results: usize,
    pub include_dotfiles: bool,
    pub absolute: bool,
    #[serde(default)]
    pub path_policy: PathPolicy,
}

/// Parameters for the `fs.grep` contract method.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GrepParams {
    pub pattern: String,
    pub input_path: String,
    pub resolved_path: PathBuf,
    pub glob: Option<String>,
    pub case_insensitive: bool,
    #[serde(deserialize_with = "deserialize_count")]
    pub max_results: usize,
    #[serde(deserialize_with = "deserialize_count")]
    pub max_matches_per_file: usize,
    #[serde(deserialize_with = "deserialize_size")]
    pub max_file_size_bytes: usize,
    pub include_dotfiles: bool,
    #[serde(default)]
    pub path_policy: PathPolicy,
}

// The catalog carries Number, not Integer. JS compares integer counters to
// these limits: count limits round up, while byte-size eligibility rounds down.
fn deserialize_count<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<usize, D::Error> {
    f64::deserialize(decoder).map(|value| value.ceil().max(0.0) as usize)
}

fn deserialize_size<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<usize, D::Error> {
    f64::deserialize(decoder).map(|value| value.floor().max(0.0) as usize)
}

/// Finds files and directories matching Bun's path-oriented glob subset.
pub(super) fn glob(params: GlobParams, cancel: &CancellationToken) -> Result<Value, RemoteError> {
    check_cancel(cancel)?;
    let search = search_root(&params.pattern, &params.cwd);
    let policy = params.path_policy.compile()?;
    policy.check(&params.cwd)?;
    policy.check(&search.root)?;
    let matcher = compile_glob(&params.pattern, &params.cwd)?;
    let mut matches = Vec::with_capacity(params.max_results.min(5_000));
    let mut truncated = false;
    let mut candidates = 0;

    walk(
        &search.root,
        search.missing_root_is_empty,
        &policy,
        None,
        cancel,
        |relative, absolute, is_directory, _| {
            candidates += 1;
            if candidates > MAX_CANDIDATES {
                truncated = true;
                return Ok(WalkControl::Stop);
            }
            let match_path = if search.absolute {
                absolute.to_path_buf()
            } else {
                search.prefix.join(relative)
            };
            let relative_text = slash_path(&match_path);
            if !matcher.is_match(&relative_text)
                || (!params.include_dotfiles
                    && !dot_components_allowed(&params.pattern, &relative_text))
                || (params.pattern.ends_with('/') && !is_directory)
                || (is_directory
                    && params.pattern.ends_with("/**")
                    && relative_text == params.pattern.trim_end_matches("/**"))
            {
                return Ok(WalkControl::Continue);
            }
            if !policy.allows(absolute) {
                return Ok(WalkControl::Continue);
            }
            if matches.len() >= params.max_results {
                truncated = true;
                return Ok(WalkControl::Stop);
            }
            matches.push(if params.absolute || search.absolute {
                absolute.to_string_lossy().into_owned()
            } else {
                search.display_path(&match_path)
            });
            Ok(WalkControl::Continue)
        },
    )
    .map_err(|error| {
        if error.code == codes::CANCELLED || error.details.is_some() {
            return error;
        }
        path_error(format!(
            "Cannot evaluate pattern \"{}\" in \"{}\": {}",
            params.pattern,
            params.cwd.display(),
            error.message
        ))
    })?;

    Ok(
        json!({ "pattern": params.pattern, "cwd": params.cwd, "matches": matches, "truncated": truncated }),
    )
}

/// Searches regular, non-binary files with an interruptible ECMAScript RegExp.
pub(super) fn grep(params: GrepParams, cancel: &CancellationToken) -> Result<Value, RemoteError> {
    check_cancel(cancel)?;
    let policy = params.path_policy.compile()?;
    policy.check(&params.resolved_path)?;
    validate_regex(&params.pattern, params.case_insensitive)?;
    let (metadata, restricted_file, mut restricted_directory) = if policy.is_unrestricted() {
        (
            Some(fs::metadata(&params.resolved_path).map_err(|error| {
                path_error(format!("Cannot access \"{}\": {error}", params.input_path))
            })?),
            None,
            None,
        )
    } else {
        match open_directory_if_present(&policy, &params.resolved_path)? {
            Some(directory) => (None, None, Some(directory)),
            None => {
                let file = open_existing_file(&policy, &params.resolved_path)?;
                if !file.metadata().map_err(io_error)?.is_file() {
                    return Err(path_error(format!(
                        "Path \"{}\" is not a regular file or directory.",
                        params.input_path
                    )));
                }
                (None, Some(file), None)
            }
        }
    };
    let mut matches = Vec::with_capacity(params.max_results.min(5_000));
    let mut files_scanned = 0usize;
    let mut truncated = false;

    if let Some(file) = restricted_file {
        files_scanned = 1;
        truncated = scan_opened_file(
            file,
            &params.resolved_path.to_string_lossy(),
            &params.pattern,
            &params,
            cancel,
            &mut matches,
        )?;
    } else if metadata.as_ref().is_some_and(fs::Metadata::is_file) {
        files_scanned = 1;
        truncated = scan_file(
            &params.resolved_path,
            &params.resolved_path.to_string_lossy(),
            &params.pattern,
            &params,
            &policy,
            cancel,
            &mut matches,
        )?;
    } else if restricted_directory.is_some() || metadata.as_ref().is_some_and(fs::Metadata::is_dir)
    {
        let filter = params
            .glob
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("**/*");
        let search = search_root(filter, &params.resolved_path);
        policy.check(&search.root)?;
        let file_matcher = compile_glob(filter, &params.resolved_path)?;
        let mut candidates = 0usize;
        let opened_root = (search.root == params.resolved_path)
            .then(|| restricted_directory.take())
            .flatten();
        walk(
            &search.root,
            search.missing_root_is_empty,
            &policy,
            opened_root,
            cancel,
            |relative, absolute, is_directory, entry| {
                candidates += 1;
                if candidates > MAX_CANDIDATES {
                    truncated = true;
                    return Ok(WalkControl::Stop);
                }
                if is_directory {
                    return Ok(WalkControl::Continue);
                }
                let match_path = if search.absolute {
                    absolute.to_path_buf()
                } else {
                    search.prefix.join(relative)
                };
                let relative_text = slash_path(&match_path);
                if !file_matcher.is_match(&relative_text)
                    || (!params.include_dotfiles && !dot_components_allowed(filter, &relative_text))
                    || !policy.allows(absolute)
                {
                    return Ok(WalkControl::Continue);
                }
                files_scanned += 1;
                let incomplete = if let Some(entry) = entry {
                    let Some(file) = open_candidate_file(&policy, absolute, entry)? else {
                        return Ok(WalkControl::Continue);
                    };
                    scan_opened_file(
                        file,
                        &search.display_path(&match_path),
                        &params.pattern,
                        &params,
                        cancel,
                        &mut matches,
                    )?
                } else {
                    scan_file(
                        absolute,
                        &search.display_path(&match_path),
                        &params.pattern,
                        &params,
                        &policy,
                        cancel,
                        &mut matches,
                    )?
                };
                if incomplete {
                    truncated = true;
                }
                if matches.len() >= params.max_results {
                    truncated = true;
                    return Ok(WalkControl::Stop);
                }
                Ok(WalkControl::Continue)
            },
        )
        .map_err(|error| {
            if error.code == codes::CANCELLED || error.details.is_some() {
                return error;
            }
            path_error(format!(
                "Cannot search \"{}\": {}",
                params.input_path, error.message
            ))
        })?;
    } else {
        return Err(path_error(format!(
            "Path \"{}\" is not a regular file or directory.",
            params.input_path
        )));
    }

    Ok(json!({
        "pattern": params.pattern,
        "path": params.input_path,
        "matches": matches,
        "filesScanned": files_scanned,
        "truncated": truncated,
    }))
}

enum PathGlob {
    Whole {
        matcher: globset::GlobMatcher,
        negated: bool,
        depth: Option<usize>,
    },
    LeadingNegation {
        first_component: globset::GlobMatcher,
        remainder: globset::GlobMatcher,
    },
}

impl PathGlob {
    fn is_match(&self, path: &str) -> bool {
        match self {
            Self::LeadingNegation {
                first_component,
                remainder,
            } => {
                let (first, remainder_path) = path.split_once('/').unwrap_or((path, ""));
                !first_component.is_match(first) && remainder.is_match(remainder_path)
            }
            Self::Whole {
                matcher,
                negated,
                depth,
            } => {
                if depth.is_some_and(|depth| path.split('/').count() != depth) {
                    return false;
                }
                matcher.is_match(path) != *negated
            }
        }
    }
}

struct SearchRoot {
    root: PathBuf,
    prefix: PathBuf,
    absolute: bool,
    explicit_current: bool,
    missing_root_is_empty: bool,
}

impl SearchRoot {
    fn display_path(&self, path: &Path) -> String {
        if self.explicit_current && !self.absolute {
            return format!(".{}{}", std::path::MAIN_SEPARATOR, path.to_string_lossy());
        }
        path.to_string_lossy().into_owned()
    }
}

fn search_root(pattern: &str, cwd: &Path) -> SearchRoot {
    let positive = pattern.trim_start_matches('!');
    let negated = (pattern.len() - positive.len()) % 2 == 1;
    let positive = positive.trim_end_matches('/');
    let explicit_current = positive.starts_with("./");
    let positive = positive.strip_prefix("./").unwrap_or(positive);
    let path = Path::new(positive);
    let absolute = path.is_absolute();
    let mut prefix = PathBuf::new();
    let mut found_wildcard = false;
    for component in path.components() {
        if component_has_glob(component.as_os_str().to_string_lossy().as_ref()) {
            found_wildcard = true;
            break;
        }
        prefix.push(component);
    }
    // A relative negative pattern matches entries outside its positive fixed
    // prefix, so it must retain the caller's original scan root.
    if negated && !absolute {
        prefix.clear();
        found_wildcard = true;
    }
    if !found_wildcard {
        prefix = prefix.parent().unwrap_or(Path::new("")).to_path_buf();
    }
    let root = if absolute {
        lexically_normalize(&prefix)
    } else {
        lexically_normalize(&cwd.join(&prefix))
    };
    SearchRoot {
        root,
        missing_root_is_empty: !prefix.as_os_str().is_empty(),
        prefix,
        absolute,
        explicit_current,
    }
}

fn component_has_glob(component: &str) -> bool {
    let mut escaped = false;
    for character in component.chars() {
        #[cfg(not(windows))]
        if !escaped && character == '\\' {
            escaped = true;
            continue;
        }
        if !escaped && matches!(character, '*' | '?' | '[' | '{') {
            return true;
        }
        escaped = false;
    }
    false
}

fn compile_glob(pattern: &str, cwd: &Path) -> Result<PathGlob, RemoteError> {
    let positive = pattern.trim_start_matches('!');
    let negated = (pattern.len() - positive.len()) % 2 == 1;
    let normalized = positive.trim_start_matches("./").trim_end_matches('/');
    let compile = |value: &str| {
        let mut builder = GlobBuilder::new(value);
        builder
            .literal_separator(true)
            .backslash_escape(!cfg!(windows));
        builder
            .build()
            .map(|glob| glob.compile_matcher())
            .map_err(|error| {
                path_error(format!(
                    "Cannot evaluate pattern \"{pattern}\" in \"{}\": {error}",
                    cwd.display()
                ))
            })
    };
    if negated
        && !Path::new(normalized).is_absolute()
        && let Some((first_component, remainder)) = normalized.split_once('/')
    {
        return Ok(PathGlob::LeadingNegation {
            first_component: compile(first_component)?,
            remainder: compile(remainder)?,
        });
    }
    Ok(PathGlob::Whole {
        matcher: compile(normalized)?,
        negated,
        depth: (negated && !normalized.contains("**")).then(|| normalized.split('/').count()),
    })
}

fn validate_regex(pattern: &str, case_insensitive: bool) -> Result<(), RemoteError> {
    let units = pattern.encode_utf16().count();
    if units > MAX_PATTERN_UTF16_UNITS {
        return Err(grep_pattern_error(format!(
            "Pattern is {units} characters, past the {MAX_PATTERN_UTF16_UNITS}-character limit."
        )));
    }
    JavascriptRegex::new(
        pattern,
        case_insensitive,
        CancellationToken::new(),
        quickjs_heap_limit(pattern.len()),
    )
    .map(|_| ())
}

fn grep_pattern_error(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "grep_pattern")
}

fn scan_file(
    absolute: &Path,
    display: &str,
    pattern: &str,
    params: &GrepParams,
    policy: &CompiledPolicy,
    cancel: &CancellationToken,
    matches: &mut Vec<Value>,
) -> Result<bool, RemoteError> {
    let allowance = params
        .max_matches_per_file
        .min(params.max_results.saturating_sub(matches.len()));
    if allowance == 0 {
        return Ok(false);
    }
    let metadata = match fs::metadata(absolute) {
        Ok(metadata)
            if metadata.is_file()
                && metadata.len() > 0
                && metadata.len() <= params.max_file_size_bytes as u64 =>
        {
            metadata
        }
        _ => return Ok(false),
    };
    let observed = match read(policy, absolute, metadata.len() as usize, cancel) {
        Ok(observed) => observed,
        // The file may disappear or become unreadable after metadata checked it.
        // Bun's scanner treats that as an empty completed scan, not a failed grep.
        Err(_) => {
            check_cancel(cancel)?;
            return Ok(false);
        }
    };
    scan_bytes(observed.bytes, display, pattern, params, cancel, matches)
}

/// Scans a file that was opened relative to a verified directory capability.
///
/// The caller owns the policy check performed on the open handle; this helper
/// deliberately never reconstructs the file's ambient path.
fn scan_opened_file(
    mut file: fs::File,
    display: &str,
    pattern: &str,
    params: &GrepParams,
    cancel: &CancellationToken,
    matches: &mut Vec<Value>,
) -> Result<bool, RemoteError> {
    let allowance = params
        .max_matches_per_file
        .min(params.max_results.saturating_sub(matches.len()));
    if allowance == 0 {
        return Ok(false);
    }
    let metadata = match file.metadata() {
        Ok(metadata)
            if metadata.is_file()
                && metadata.len() > 0
                && metadata.len() <= params.max_file_size_bytes as u64 =>
        {
            metadata
        }
        _ => return Ok(false),
    };
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut chunk = [0; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let remaining = (params.max_file_size_bytes + 1 - bytes.len()).min(chunk.len());
        if remaining == 0 {
            break;
        }
        let count = match file.read(&mut chunk[..remaining]) {
            Ok(count) => count,
            // A candidate can be removed or become unreadable after it was
            // enumerated. Bun treats that as an empty completed scan.
            Err(_) => return Ok(false),
        };
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() > params.max_file_size_bytes {
        return Ok(false);
    }
    scan_bytes(bytes, display, pattern, params, cancel, matches)
}

fn scan_bytes(
    bytes: Vec<u8>,
    display: &str,
    pattern: &str,
    params: &GrepParams,
    cancel: &CancellationToken,
    matches: &mut Vec<Value>,
) -> Result<bool, RemoteError> {
    if bytes.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return Ok(false);
    }
    let content = String::from_utf8_lossy(&bytes);
    let regex = JavascriptRegex::new(
        pattern,
        params.case_insensitive,
        cancel.clone(),
        quickjs_heap_limit(bytes.len()),
    )?;
    regex.start_file_budget(GREP_FILE_BUDGET);
    let matches_before_file = matches.len();
    let allowance = params
        .max_matches_per_file
        .min(params.max_results.saturating_sub(matches.len()));
    let mut more_matches = false;
    let mut file_matches = 0usize;
    for (index, line) in content.split('\n').enumerate() {
        check_cancel(cancel)?;
        match regex.is_match(line)? {
            JsMatch::Matched if matches.len() < params.max_results && file_matches < allowance => {
                matches.push(json!({ "file": display, "line": index + 1, "text": line }));
                file_matches += 1;
            }
            JsMatch::Matched => {
                more_matches = true;
                break;
            }
            JsMatch::NotMatched => {}
            JsMatch::Interrupted => {
                // The scanner worker reports no partial matches when its timer
                // terminates it. Keeping these would claim results from a file
                // that was only partly searched.
                matches.truncate(matches_before_file);
                return Ok(true);
            }
        }
    }
    Ok(more_matches)
}

enum JsMatch {
    Matched,
    NotMatched,
    Interrupted,
}

struct JavascriptRegex {
    _runtime: Runtime,
    context: Context,
    cancel: CancellationToken,
    interruption: Arc<RegexInterruption>,
}

struct RegexInterruption {
    deadline: Mutex<Option<Instant>>,
    triggered: AtomicBool,
}

impl JavascriptRegex {
    fn new(
        pattern: &str,
        case_insensitive: bool,
        cancel: CancellationToken,
        heap_limit: usize,
    ) -> Result<Self, RemoteError> {
        let runtime =
            Runtime::new().map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?;
        runtime.set_memory_limit(heap_limit);
        // Stay below the blocking worker's native stack; an engine exception
        // must precede any OS-thread stack overflow.
        runtime.set_max_stack_size(512 * 1024);
        let interrupted_cancel = cancel.clone();
        let interruption = Arc::new(RegexInterruption {
            deadline: Mutex::new(None),
            triggered: AtomicBool::new(false),
        });
        let interrupted_deadline = Arc::clone(&interruption);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            interrupted_cancel.is_cancelled() || interrupted_deadline.should_interrupt()
        })));
        let context = Context::full(&runtime)
            .map_err(|error| RemoteError::new(codes::INTERNAL, error.to_string()))?;
        let flags = if case_insensitive { "i" } else { "" };
        let source = serde_json::to_string(pattern).expect("a Rust string always serializes");
        let flags = serde_json::to_string(flags).expect("a Rust string always serializes");
        context
            .with(|ctx| {
                ctx.eval::<(), _>(format!(
                    "globalThis.__mangoGrep = new RegExp({source}, {flags});"
                ))
                .catch(&ctx)
                .map_err(|error| error.to_string())
            })
            .map_err(|error| {
                grep_pattern_error(format!("Invalid pattern \"{pattern}\": {error}"))
            })?;
        Ok(Self {
            _runtime: runtime,
            context,
            cancel,
            interruption,
        })
    }

    /// Starts the wall-clock allowance after compiling the regular expression.
    fn start_file_budget(&self, budget: Duration) {
        *self
            .interruption
            .deadline
            .lock()
            .expect("the regex deadline mutex is not poisoned") = Some(Instant::now() + budget);
        self.interruption.triggered.store(false, Ordering::Release);
    }

    fn is_match(&self, line: &str) -> Result<JsMatch, RemoteError> {
        if self.cancel.is_cancelled() {
            return Err(RemoteError::new(
                codes::CANCELLED,
                "Filesystem operation cancelled",
            ));
        }
        if self.interruption.expired() {
            return Ok(JsMatch::Interrupted);
        }
        let line = serde_json::to_string(line).expect("a Rust string always serializes");
        match self
            .context
            .with(|ctx| ctx.eval::<bool, _>(format!("__mangoGrep.test({line})")))
        {
            Ok(true) => Ok(JsMatch::Matched),
            Ok(false) => Ok(JsMatch::NotMatched),
            Err(_) if self.cancel.is_cancelled() => Err(RemoteError::new(
                codes::CANCELLED,
                "Filesystem operation cancelled",
            )),
            // The TypeScript scanner abandons a worker that hits its regex
            // resource limit. A compiled `RegExp#test` has no user error left
            // to report, so QuickJS errors here mean this file was incomplete.
            Err(_) => Ok(JsMatch::Interrupted),
        }
    }
}

impl RegexInterruption {
    fn expired(&self) -> bool {
        self.deadline
            .lock()
            .expect("the regex deadline mutex is not poisoned")
            .is_some_and(|deadline| Instant::now() >= deadline)
    }

    fn should_interrupt(&self) -> bool {
        let expired = self.expired();
        if expired {
            self.triggered.store(true, Ordering::Release);
        }
        expired
    }

    #[cfg(test)]
    fn was_triggered(&self) -> bool {
        self.triggered.load(Ordering::Acquire)
    }
}

fn quickjs_heap_limit(input_bytes: usize) -> usize {
    input_bytes
        .saturating_mul(QUICKJS_INPUT_MULTIPLIER)
        .saturating_add(QUICKJS_RUNTIME_BYTES)
}

enum WalkControl {
    Continue,
    Stop,
}

fn walk(
    root: &Path,
    missing_root_is_empty: bool,
    policy: &CompiledPolicy,
    opened_root: Option<BoundDir>,
    cancel: &CancellationToken,
    visit: impl FnMut(
        &Path,
        &Path,
        bool,
        Option<&cap_std::fs::DirEntry>,
    ) -> Result<WalkControl, RemoteError>,
) -> Result<(), RemoteError> {
    if policy.is_unrestricted() {
        walk_ambient(root, missing_root_is_empty, cancel, visit)
    } else if let Some(opened_root) = opened_root {
        walk_opened_capability(root, opened_root, policy, cancel, visit)
    } else {
        walk_capability(root, missing_root_is_empty, policy, cancel, visit)
    }
}

fn walk_ambient(
    root: &Path,
    missing_root_is_empty: bool,
    cancel: &CancellationToken,
    mut visit: impl FnMut(
        &Path,
        &Path,
        bool,
        Option<&cap_std::fs::DirEntry>,
    ) -> Result<WalkControl, RemoteError>,
) -> Result<(), RemoteError> {
    let mut directories = vec![PathBuf::new()];
    while let Some(relative_directory) = directories.pop() {
        check_cancel(cancel)?;
        let absolute_directory = root.join(&relative_directory);
        let entries = match fs::read_dir(&absolute_directory) {
            Ok(entries) => entries,
            Err(error)
                if missing_root_is_empty
                    && relative_directory.as_os_str().is_empty()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) =>
            {
                return Ok(());
            }
            Err(error) => return Err(io_error(error)),
        };
        for entry in entries {
            check_cancel(cancel)?;
            let entry = entry.map_err(io_error)?;
            let relative = relative_directory.join(entry.file_name());
            let absolute = root.join(&relative);
            let is_directory = entry.file_type().map_err(io_error)?.is_dir();
            if matches!(
                visit(&relative, &absolute, is_directory, None)?,
                WalkControl::Stop
            ) {
                return Ok(());
            }
            if is_directory {
                directories.push(relative);
            }
        }
    }
    Ok(())
}

fn walk_capability(
    root: &Path,
    missing_root_is_empty: bool,
    policy: &CompiledPolicy,
    cancel: &CancellationToken,
    visit: impl FnMut(
        &Path,
        &Path,
        bool,
        Option<&cap_std::fs::DirEntry>,
    ) -> Result<WalkControl, RemoteError>,
) -> Result<(), RemoteError> {
    walk_capability_with_hook(
        root,
        missing_root_is_empty,
        policy,
        cancel,
        &NoopSearchHook,
        visit,
    )
}

trait SearchHook {
    fn after_root_open(&self);
}

struct NoopSearchHook;

impl SearchHook for NoopSearchHook {
    fn after_root_open(&self) {}
}

fn walk_capability_with_hook(
    root: &Path,
    missing_root_is_empty: bool,
    policy: &CompiledPolicy,
    cancel: &CancellationToken,
    hook: &dyn SearchHook,
    visit: impl FnMut(
        &Path,
        &Path,
        bool,
        Option<&cap_std::fs::DirEntry>,
    ) -> Result<WalkControl, RemoteError>,
) -> Result<(), RemoteError> {
    let root_path = root.to_path_buf();
    let root = match open_directory_if_present(policy, root)? {
        Some(root) => root,
        None if missing_root_is_empty => return Ok(()),
        None => return Err(io_error(std::io::Error::from(std::io::ErrorKind::NotFound))),
    };
    hook.after_root_open();
    walk_opened_capability(&root_path, root, policy, cancel, visit)
}

fn walk_opened_capability(
    root_path: &Path,
    root: BoundDir,
    policy: &CompiledPolicy,
    cancel: &CancellationToken,
    mut visit: impl FnMut(
        &Path,
        &Path,
        bool,
        Option<&cap_std::fs::DirEntry>,
    ) -> Result<WalkControl, RemoteError>,
) -> Result<(), RemoteError> {
    let mut directories = vec![(root, PathBuf::new())];
    while let Some((directory, relative_directory)) = directories.pop() {
        check_cancel(cancel)?;
        let control = match directory.with_dir(|directory| {
            let entries = directory.entries().map_err(io_error)?;
            for entry in entries {
                check_cancel(cancel)?;
                let entry = entry.map_err(io_error)?;
                let relative = relative_directory.join(entry.file_name());
                // Preserve the requested spelling for matching and display. The
                // capability helpers validate the handle's final host path before
                // it can be read or traversed.
                let absolute = root_path.join(&relative);
                let is_directory = entry.file_type().map_err(io_error)?.is_dir();
                let allowed = policy.allows(&absolute);
                if matches!(
                    visit(
                        &relative,
                        &absolute,
                        is_directory,
                        (!is_directory && allowed).then_some(&entry)
                    )?,
                    WalkControl::Stop
                ) {
                    return Ok(WalkControl::Stop);
                }
                if is_directory && allowed {
                    let child = directory
                        .open_dir_nofollow(entry.file_name())
                        .map_err(io_error)?;
                    let child = bind_opened_directory(policy, &absolute, child)?;
                    directories.push((child, relative));
                }
            }
            Ok(WalkControl::Continue)
        }) {
            Ok(control) => control,
            Err(error) if is_anchor_reopen_error(&error) => continue,
            Err(error) => return Err(error),
        };
        if matches!(control, WalkControl::Stop) {
            return Ok(());
        }
    }
    Ok(())
}

fn is_anchor_reopen_error(error: &RemoteError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("anchorReopen"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn open_candidate_file(
    policy: &CompiledPolicy,
    path: &Path,
    entry: &cap_std::fs::DirEntry,
) -> Result<Option<fs::File>, RemoteError> {
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;

        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    let file = match entry.open_with(&options) {
        Ok(file) => file,
        // The file may disappear or become unreadable after it was
        // enumerated. Bun treats that as an empty completed scan.
        Err(_) => return Ok(None),
    };
    verify_opened_file(policy, path, file).map(Some)
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}

fn dot_components_allowed(pattern: &str, path: &str) -> bool {
    #[cfg(windows)]
    let pattern = pattern.replace('\\', "/");
    #[cfg(windows)]
    let pattern = pattern.as_str();
    let positive = pattern.trim_start_matches('!').trim_end_matches('/');
    let positive = positive.strip_prefix("./").unwrap_or(positive);
    let pattern_components: Vec<_> = positive
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let path_components: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    let mut previous = vec![false; path_components.len() + 1];
    previous[0] = true;
    for component in pattern_components {
        let mut current = vec![false; path_components.len() + 1];
        if component == "**" {
            current.clone_from(&previous);
            for index in 0..path_components.len() {
                if current[index] && !path_components[index].starts_with('.') {
                    current[index + 1] = true;
                }
            }
        } else {
            for index in 0..path_components.len() {
                if previous[index]
                    && (!path_components[index].starts_with('.') || component.starts_with('.'))
                {
                    current[index + 1] = true;
                }
            }
        }
        previous = current;
    }
    previous[path_components.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch_dir;

    fn token() -> CancellationToken {
        CancellationToken::new()
    }

    #[test]
    fn wire_number_limits_preserve_javascript_counter_comparisons() {
        let params: GrepParams = serde_json::from_value(json!({
            "pattern":"x", "inputPath":".", "resolvedPath":".",
            "caseInsensitive":false,"maxResults":1.0,"maxMatchesPerFile":1.25,
            "maxFileSizeBytes":1.75,"includeDotfiles":false
        }))
        .unwrap();
        assert_eq!(params.max_results, 1);
        assert_eq!(params.max_matches_per_file, 2);
        assert_eq!(params.max_file_size_bytes, 1);
    }
    fn glob_params(root: &Path, pattern: &str) -> GlobParams {
        GlobParams {
            pattern: pattern.to_owned(),
            cwd: root.to_path_buf(),
            max_results: 100,
            include_dotfiles: false,
            absolute: false,
            path_policy: PathPolicy::default(),
        }
    }
    fn grep_params(root: &Path, pattern: &str) -> GrepParams {
        GrepParams {
            pattern: pattern.to_owned(),
            input_path: ".".to_owned(),
            resolved_path: root.to_path_buf(),
            glob: None,
            case_insensitive: false,
            max_results: 100,
            max_matches_per_file: 10,
            max_file_size_bytes: 1024 * 1024,
            include_dotfiles: false,
            path_policy: PathPolicy::default(),
        }
    }

    #[test]
    fn glob_uses_bun_style_braces_recursive_patterns_dotfiles_and_native_order() {
        let root = scratch_dir("filesystem-search-glob");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        for (path, content) in [
            ("a.txt", "a"),
            ("b.md", "b"),
            (".hidden.txt", "h"),
            ("src/a.ts", "a"),
            ("src/.dot.ts", "d"),
            ("src/nested/b.ts", "b"),
            ("other/visible.md", "v"),
            (".hidden/visible.ts", "v"),
            (".hidden/.secret.ts", "s"),
            (".hidden/.dot.ts", "d"),
        ] {
            fs::write(root.join(path), content).unwrap();
        }
        let result = glob(glob_params(&root, "**/*.ts"), &token()).unwrap();
        assert_eq!(
            result["matches"],
            json!([
                format!("src{}a.ts", std::path::MAIN_SEPARATOR),
                format!(
                    "src{}nested{}b.ts",
                    std::path::MAIN_SEPARATOR,
                    std::path::MAIN_SEPARATOR
                )
            ])
        );
        let result = glob(glob_params(&root, "*.{txt,md}"), &token()).unwrap();
        let native_order: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name == "a.txt" || name == "b.md")
            .collect();
        assert_eq!(result["matches"], json!(native_order));
        let result = glob(glob_params(&root, "**/.dot.ts"), &token()).unwrap();
        assert_eq!(
            result["matches"],
            json!([format!("src{}.dot.ts", std::path::MAIN_SEPARATOR)])
        );
        let result = glob(glob_params(&root, ".hidden/*"), &token()).unwrap();
        assert_eq!(
            result["matches"],
            json!([format!(".hidden{}visible.ts", std::path::MAIN_SEPARATOR)])
        );
        let mut params = glob_params(&root, "**/*.ts");
        params.include_dotfiles = true;
        let result = glob(params, &token()).unwrap();
        assert!(
            result["matches"]
                .as_array()
                .unwrap()
                .contains(&json!(format!(
                    ".hidden{}.secret.ts",
                    std::path::MAIN_SEPARATOR
                )))
        );
        let result = glob(glob_params(&root, "!src/*.ts"), &token()).unwrap();
        assert_eq!(result["matches"], json!([]));
        let result = glob(glob_params(&root, "./*.txt"), &token()).unwrap();
        assert_eq!(
            result["matches"],
            json!([format!(".{}a.txt", std::path::MAIN_SEPARATOR)])
        );
        let result = glob(glob_params(&root, "./src/*.ts"), &token()).unwrap();
        assert_eq!(
            result["matches"],
            json!([format!(
                ".{}src{}a.ts",
                std::path::MAIN_SEPARATOR,
                std::path::MAIN_SEPARATOR
            )])
        );
        assert_eq!(
            glob(glob_params(&root, "missing/*.txt"), &token()).unwrap()["matches"],
            json!([])
        );
        assert_eq!(
            glob(glob_params(&root, "a.txt/*"), &token()).unwrap()["matches"],
            json!([])
        );

        let missing_cwd = root.join("missing");
        assert!(glob(glob_params(&missing_cwd, "*"), &token()).is_err());
    }

    #[test]
    fn leading_glob_negation_applies_to_the_first_path_component() {
        let root = scratch_dir("filesystem-search-leading-negation");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        for path in [
            "src/excluded.ts",
            "src/readme.md",
            "other/included.ts",
            "other/readme.md",
        ] {
            fs::write(root.join(path), "needle\n").unwrap();
        }
        let included = format!("other{}included.ts", std::path::MAIN_SEPARATOR);

        assert_eq!(
            glob(glob_params(&root, "!src/*.ts"), &token()).unwrap()["matches"],
            json!([included])
        );

        let mut parameters = grep_params(&root, "needle");
        parameters.glob = Some("!src/*.ts".to_owned());
        let result = grep(parameters, &token()).unwrap();
        assert_eq!(result["filesScanned"], 1);
        assert_eq!(
            result["matches"],
            json!([{ "file": included, "line": 1, "text": "needle" }])
        );
    }

    #[test]
    fn relative_parent_globs_scan_and_authorize_the_fixed_prefix() {
        let root = scratch_dir("filesystem-search-parent-prefix");
        let cwd = root.join("inside");
        let outside = root.join("outside");
        fs::create_dir(&cwd).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("match.txt"), "needle\n").unwrap();
        let expected = Path::new("..").join("outside").join("match.txt");

        let result = glob(glob_params(&cwd, "../outside/*.txt"), &token()).unwrap();
        assert_eq!(result["matches"], json!([expected]));

        let mut grep_parameters = grep_params(&cwd, "needle");
        grep_parameters.glob = Some("../outside/*.txt".to_string());
        let result = grep(grep_parameters, &token()).unwrap();
        assert_eq!(result["matches"][0]["file"], json!(expected));

        let mut denied = glob_params(&cwd, "../outside/*.txt");
        denied.path_policy.allowed_roots = vec![cwd];
        assert_eq!(
            glob(denied, &token()).unwrap_err().details.unwrap()["kind"],
            "path_access"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn escaped_glob_metacharacters_match_literal_names_for_glob_and_grep() {
        let root = scratch_dir("filesystem-search-escaped-glob");
        fs::write(root.join("a*b.txt"), "needle\n").unwrap();
        fs::write(root.join("axb.txt"), "needle\n").unwrap();

        let result = glob(glob_params(&root, r"a\*b.txt"), &token()).unwrap();
        assert_eq!(result["matches"], json!(["a*b.txt"]));

        let mut grep_parameters = grep_params(&root, "needle");
        grep_parameters.glob = Some(r"a\*b.txt".to_string());
        let result = grep(grep_parameters, &token()).unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(result["matches"][0]["file"], "a*b.txt");
    }

    #[test]
    fn grep_supports_js_constructs_crlf_and_the_final_empty_line() {
        let root = scratch_dir("filesystem-search-grep");
        fs::write(root.join("sample.txt"), "Foofoo\r\nfoofoo\nlast\n").unwrap();
        for (pattern, expected) in [
            ("(?<=foo)foo", 2),
            ("(foo)\\1", 2),
            ("(?<word>foo)\\k<word>", 2),
        ] {
            let mut params = grep_params(&root, pattern);
            params.case_insensitive = true;
            let result = grep(params, &token()).unwrap();
            assert_eq!(
                result["matches"].as_array().unwrap().len(),
                expected,
                "{pattern}"
            );
        }
        let result = grep(grep_params(&root, "^$"), &token()).unwrap();
        assert_eq!(
            result["matches"],
            json!([{ "file": "sample.txt", "line": 4, "text": "" }])
        );
    }

    #[test]
    fn grep_preserves_explicit_current_paths_and_empty_fixed_prefixes() {
        let root = scratch_dir("filesystem-search-grep-prefix");
        fs::write(root.join("sample.txt"), "needle\n").unwrap();
        let mut params = grep_params(&root, "needle");
        params.glob = Some("./*.txt".to_string());
        let result = grep(params, &token()).unwrap();
        assert_eq!(
            result["matches"][0]["file"],
            format!(".{}sample.txt", std::path::MAIN_SEPARATOR)
        );

        for filter in ["missing/*.txt", "sample.txt/*"] {
            let mut params = grep_params(&root, "needle");
            params.glob = Some(filter.to_string());
            let result = grep(params, &token()).unwrap();
            assert_eq!(result["matches"], json!([]));
            assert_eq!(result["filesScanned"], 0);
        }
    }

    #[cfg(windows)]
    #[test]
    fn dot_rules_accept_native_absolute_windows_patterns() {
        assert!(dot_components_allowed(
            r"C:\workspace\*.txt",
            "C:/workspace/file.txt"
        ));
    }

    #[test]
    fn grep_enforces_caps_binary_filter_policy_and_cancellation() {
        let root = scratch_dir("filesystem-search-bounds");
        fs::write(root.join("a.txt"), "hit\nhit\nhit\n").unwrap();
        fs::write(root.join("binary.txt"), b"hit\0").unwrap();
        let mut params = grep_params(&root, "hit");
        params.max_matches_per_file = 1;
        let result = grep(params, &token()).unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(result["filesScanned"], 2);
        assert_eq!(result["truncated"], true);
        let cancelled = token();
        cancelled.cancel();
        assert_eq!(
            glob(glob_params(&root, "**/*"), &cancelled)
                .unwrap_err()
                .code,
            codes::CANCELLED
        );
    }

    #[test]
    fn search_roots_must_be_authorized_before_the_walk_starts() {
        let dir = scratch_dir("filesystem-search-root-policy");
        let allowed = dir.join("allowed");
        let outside = dir.join("outside");
        fs::create_dir(&allowed).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![allowed.clone()],
            ..PathPolicy::default()
        };

        let mut params = glob_params(&outside, "**/*");
        params.path_policy = policy.clone();
        let error = glob(params, &token()).unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "path_access");

        let mut params = glob_params(&allowed, &format!("{}/**/*", outside.display()));
        params.path_policy = policy.clone();
        let error = glob(params, &token()).unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "path_access");

        let mut params = grep_params(&outside, "secret");
        params.path_policy = policy;
        let error = grep(params, &token()).unwrap_err();
        assert_eq!(error.details.unwrap()["kind"], "path_access");
    }

    #[test]
    fn restricted_glob_and_grep_keep_their_existing_result_shapes() {
        let root = scratch_dir("filesystem-search-capability-results");
        fs::write(root.join("match.txt"), "needle\n").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        };

        let mut glob_parameters = glob_params(&root, "*.txt");
        glob_parameters.path_policy = policy.clone();
        assert_eq!(
            glob(glob_parameters, &token()).unwrap()["matches"],
            json!(["match.txt"])
        );

        let mut grep_parameters = grep_params(&root, "needle");
        grep_parameters.path_policy = policy;
        assert_eq!(
            grep(grep_parameters, &token()).unwrap()["matches"],
            json!([{ "file": "match.txt", "line": 1, "text": "needle" }])
        );
    }

    #[cfg(unix)]
    #[test]
    fn restricted_grep_rejects_non_regular_root_handles() {
        use nix::sys::stat::Mode;
        use nix::unistd::mkfifo;

        let root = scratch_dir("filesystem-search-capability-fifo");
        let fifo = root.join("input");
        mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
        let mut parameters = grep_params(&fifo, "needle");
        parameters.input_path = "input".to_string();
        parameters.path_policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        };

        assert_eq!(
            grep(parameters, &token()).unwrap_err().message,
            "Path \"input\" is not a regular file or directory."
        );
    }

    #[cfg(unix)]
    #[test]
    fn restricted_grep_skips_unmatched_fifo_before_opening_candidates() {
        use nix::sys::stat::Mode;
        use nix::unistd::mkfifo;

        let root = scratch_dir("filesystem-search-unmatched-fifo");
        mkfifo(root.join("unmatched.fifo").as_path(), Mode::S_IRUSR).unwrap();
        let mut parameters = grep_params(&root, "needle");
        parameters.glob = Some("*.txt".to_owned());
        parameters.path_policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        };

        let result = grep(parameters, &token()).unwrap();

        assert_eq!(result["matches"], json!([]));
        assert_eq!(result["filesScanned"], 0);
        assert_eq!(result["truncated"], false);
    }

    #[cfg(unix)]
    struct SwapSearchRoot {
        root: PathBuf,
        parked: PathBuf,
        replacement: PathBuf,
    }

    #[cfg(unix)]
    impl SearchHook for SwapSearchRoot {
        fn after_root_open(&self) {
            use std::os::unix::fs::symlink;

            fs::rename(&self.root, &self.parked).unwrap();
            symlink(&self.replacement, &self.root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn restricted_walk_never_reads_through_a_root_swapped_after_authorization() {
        let sandbox = scratch_dir("filesystem-search-capability-swap");
        let allowed = sandbox.join("allowed");
        let root = allowed.join("workspace");
        let parked = allowed.join("workspace-before-swap");
        let outside = sandbox.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("in-scope.txt"), "safe").unwrap();
        fs::write(outside.join("in-scope.txt"), "leaked").unwrap();
        let policy = PathPolicy {
            allowed_roots: vec![allowed],
            ..PathPolicy::default()
        }
        .compile()
        .unwrap();
        let hook = SwapSearchRoot {
            root: root.clone(),
            parked,
            replacement: outside,
        };
        let mut offered_file = false;

        walk_capability_with_hook(
            &root,
            false,
            &policy,
            &token(),
            &hook,
            |_, _, is_directory, entry| {
                offered_file |= !is_directory && entry.is_some();
                Ok(WalkControl::Continue)
            },
        )
        .unwrap();

        assert!(!offered_file, "the replacement path must never be opened");
    }

    #[test]
    fn grep_regex_validation_uses_the_service_error_shape() {
        for pattern in ["(", &"a".repeat(MAX_PATTERN_UTF16_UNITS + 1)] {
            let error = validate_regex(pattern, false).unwrap_err();
            assert_eq!(error.code, codes::INTERNAL);
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("kind")),
                Some(&json!("grep_pattern"))
            );
            assert!(
                error
                    .message
                    .starts_with(&format!("Invalid pattern \"{pattern}\":"))
                    || error.message.starts_with("Pattern is ")
            );
        }
    }

    #[test]
    fn regexp_keeps_ecmascript_non_unicode_utf16_semantics() {
        // `/^..$/` is true in JavaScript without the `u` flag because an astral
        // character has two UTF-16 code units. Rust Unicode regex engines return
        // false here, which was the concrete parity gap in the first port.
        let regex = JavascriptRegex::new("^..$", false, token(), quickjs_heap_limit(4)).unwrap();
        regex.start_file_budget(GREP_FILE_BUDGET);
        assert!(matches!(regex.is_match("😀").unwrap(), JsMatch::Matched));
    }

    #[test]
    fn regexp_interrupts_a_single_catastrophic_match() {
        let regex =
            JavascriptRegex::new("^(a+)+$", false, token(), quickjs_heap_limit(50_001)).unwrap();
        // Compiling is deliberately outside the file budget. A 10 ms allowance
        // leaves enough time to enter the engine but cannot complete this match.
        regex.start_file_budget(Duration::from_millis(10));
        let line = format!("{}b", "a".repeat(50_000));
        assert!(matches!(
            regex.is_match(&line).unwrap(),
            JsMatch::Interrupted
        ));
        assert!(
            regex.interruption.was_triggered(),
            "QuickJS must invoke the interrupt callback during the match"
        );
    }

    #[test]
    fn unfinished_file_discards_its_partial_matches_but_keeps_earlier_files() {
        let root = scratch_dir("filesystem-grep-incomplete");
        let path = root.join("slow.txt");
        fs::write(&path, format!("a\n{}b", "a".repeat(50_000))).unwrap();
        let params = grep_params(&root, "^(a+)+$");
        let previous = json!({"file":"earlier.txt","line":1,"text":"a"});
        let mut matches = vec![previous.clone()];
        assert!(
            scan_file(
                &path,
                "slow.txt",
                &params.pattern,
                &params,
                &params.path_policy.compile().unwrap(),
                &token(),
                &mut matches
            )
            .unwrap()
        );
        assert_eq!(matches, vec![previous]);
    }

    #[test]
    fn grep_keeps_a_utf8_bom_like_buns_utf8_reader() {
        let root = scratch_dir("filesystem-search-bom");
        fs::write(root.join("bom.txt"), b"\xef\xbb\xbffirst\n").unwrap();
        assert!(
            grep(grep_params(&root, "^first"), &token()).unwrap()["matches"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            grep(grep_params(&root, "^\u{feff}first"), &token()).unwrap()["matches"],
            json!([{ "file": "bom.txt", "line": 1, "text": "\u{feff}first" }])
        );
    }
}
