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
use rquickjs::{CatchResultExt, Context, Function, Persistent, Runtime};
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
    // Compiles the pattern once: it validates the request up front and its
    // engine then serves every candidate file of this operation.
    let mut matcher = GrepMatcher::new(&params.pattern, params.case_insensitive, cancel.clone())?;
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
            &params,
            &mut matcher,
            cancel,
            &mut matches,
        )?;
    } else if metadata.as_ref().is_some_and(fs::Metadata::is_file) {
        files_scanned = 1;
        truncated = scan_file(
            &params.resolved_path,
            &params.resolved_path.to_string_lossy(),
            &params,
            &policy,
            &mut matcher,
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
                        &params,
                        &mut matcher,
                        cancel,
                        &mut matches,
                    )?
                } else {
                    scan_file(
                        absolute,
                        &search.display_path(&match_path),
                        &params,
                        &policy,
                        &mut matcher,
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

fn check_pattern_length(pattern: &str) -> Result<(), RemoteError> {
    let units = pattern.encode_utf16().count();
    if units > MAX_PATTERN_UTF16_UNITS {
        return Err(grep_pattern_error(format!(
            "Pattern is {units} characters, past the {MAX_PATTERN_UTF16_UNITS}-character limit."
        )));
    }
    Ok(())
}

fn grep_pattern_error(message: impl Into<String>) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message).with_detail("kind", "grep_pattern")
}

/// Matches one file may still contribute given the results collected so far.
fn match_allowance(params: &GrepParams, collected: usize) -> usize {
    params
        .max_matches_per_file
        .min(params.max_results.saturating_sub(collected))
}

/// Shared prologue of a file scan: the byte length worth reading, or `None`
/// when the file is skipped.
///
/// A file is skipped when no match allowance is left, when its metadata cannot
/// be read, or when it is not a regular, non-empty file within
/// `max_file_size_bytes`. The metadata is taken lazily so an exhausted
/// allowance costs no syscall.
///
/// # Example
///
/// ```ignore
/// let Some(len) = scannable_len(params, matches.len(), || fs::metadata(path)) else {
///     return Ok(false);
/// };
/// ```
fn scannable_len(
    params: &GrepParams,
    collected: usize,
    metadata: impl FnOnce() -> std::io::Result<fs::Metadata>,
) -> Option<usize> {
    if match_allowance(params, collected) == 0 {
        return None;
    }
    let metadata = metadata().ok()?;
    let len = metadata.len();
    (metadata.is_file() && len > 0 && len <= params.max_file_size_bytes as u64)
        .then_some(len as usize)
}

fn scan_file(
    absolute: &Path,
    display: &str,
    params: &GrepParams,
    policy: &CompiledPolicy,
    matcher: &mut GrepMatcher,
    cancel: &CancellationToken,
    matches: &mut Vec<Value>,
) -> Result<bool, RemoteError> {
    let Some(len) = scannable_len(params, matches.len(), || fs::metadata(absolute)) else {
        return Ok(false);
    };
    let observed = match read(policy, absolute, len, cancel) {
        Ok(observed) => observed,
        // The file may disappear or become unreadable after metadata checked it.
        // Bun's scanner treats that as an empty completed scan, not a failed grep.
        Err(_) => {
            check_cancel(cancel)?;
            return Ok(false);
        }
    };
    scan_bytes(observed.bytes, display, params, matcher, cancel, matches)
}

/// Scans a file that was opened relative to a verified directory capability.
///
/// The caller owns the policy check performed on the open handle; this helper
/// deliberately never reconstructs the file's ambient path.
fn scan_opened_file(
    mut file: fs::File,
    display: &str,
    params: &GrepParams,
    matcher: &mut GrepMatcher,
    cancel: &CancellationToken,
    matches: &mut Vec<Value>,
) -> Result<bool, RemoteError> {
    let Some(len) = scannable_len(params, matches.len(), || file.metadata()) else {
        return Ok(false);
    };
    let mut bytes = Vec::with_capacity(len);
    let mut chunk = [0; 64 * 1024];
    loop {
        check_cancel(cancel)?;
        let remaining =
            (params.max_file_size_bytes.saturating_add(1) - bytes.len()).min(chunk.len());
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
    scan_bytes(bytes, display, params, matcher, cancel, matches)
}

fn scan_bytes(
    bytes: Vec<u8>,
    display: &str,
    params: &GrepParams,
    matcher: &mut GrepMatcher,
    cancel: &CancellationToken,
    matches: &mut Vec<Value>,
) -> Result<bool, RemoteError> {
    if super::text::looks_binary(&bytes) {
        return Ok(false);
    }
    let content = String::from_utf8_lossy(&bytes);
    let regex = matcher.for_file(bytes.len())?;
    let matches_before_file = matches.len();
    let allowance = match_allowance(params, matches.len());
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
                matcher.discard_engine();
                return Ok(true);
            }
        }
    }
    Ok(more_matches)
}

/// The regular-expression engine of one grep operation.
///
/// Compiling the pattern and building its QuickJS context is the expensive
/// part of a scan, so it is done once and lent to every candidate file. What
/// is per file is reset in [`GrepMatcher::for_file`]: the heap limit, which is
/// sized to that file, and the wall-clock allowance. The matcher is owned by
/// one `grep` call on its blocking worker; nothing is shared or cached across
/// operations.
///
/// An engine whose file was interrupted is dropped rather than reset, so no
/// state of an abandoned match can reach the next file; the next
/// [`GrepMatcher::for_file`] compiles a fresh one.
///
/// # Example
///
/// ```ignore
/// let mut matcher = GrepMatcher::new("^needle", false, cancel.clone())?;
/// let regex = matcher.for_file(bytes.len())?;
/// let hit = regex.is_match("needle in a haystack")?;
/// ```
struct GrepMatcher {
    pattern: String,
    case_insensitive: bool,
    cancel: CancellationToken,
    file_budget: Duration,
    engine: Option<JavascriptRegex>,
}

impl GrepMatcher {
    /// Validates `pattern` and compiles it for the operation's files.
    fn new(
        pattern: &str,
        case_insensitive: bool,
        cancel: CancellationToken,
    ) -> Result<Self, RemoteError> {
        Self::with_file_budget(pattern, case_insensitive, cancel, GREP_FILE_BUDGET)
    }

    /// [`Self::new`] with a wall-clock allowance other than [`GREP_FILE_BUDGET`].
    fn with_file_budget(
        pattern: &str,
        case_insensitive: bool,
        cancel: CancellationToken,
        file_budget: Duration,
    ) -> Result<Self, RemoteError> {
        check_pattern_length(pattern)?;
        let mut matcher = Self {
            pattern: pattern.to_owned(),
            case_insensitive,
            cancel,
            file_budget,
            engine: None,
        };
        matcher.engine = Some(matcher.compile(quickjs_heap_limit(pattern.len()))?);
        Ok(matcher)
    }

    fn compile(&self, heap_limit: usize) -> Result<JavascriptRegex, RemoteError> {
        JavascriptRegex::new(
            &self.pattern,
            self.case_insensitive,
            self.cancel.clone(),
            heap_limit,
        )
        // The interrupt handler also stops a compilation, which the engine
        // reports as an invalid pattern; a cancelled operation is not one.
        .map_err(|error| match check_cancel(&self.cancel) {
            Err(cancelled) => cancelled,
            Ok(()) => error,
        })
    }

    /// Prepares the engine for a file of `input_bytes` bytes.
    ///
    /// The heap limit is what a fresh engine would get for this file and the
    /// wall-clock allowance starts over, so an earlier file's size or slowness
    /// never counts against this one.
    fn for_file(&mut self, input_bytes: usize) -> Result<&JavascriptRegex, RemoteError> {
        let heap_limit = quickjs_heap_limit(input_bytes);
        let engine = match self.engine.take() {
            Some(engine) => engine,
            None => self.compile(heap_limit)?,
        };
        engine.set_heap_limit(heap_limit);
        engine.start_file_budget(self.file_budget);
        Ok(self.engine.insert(engine))
    }

    /// Drops the engine; the next file compiles a new one.
    fn discard_engine(&mut self) {
        self.engine = None;
    }
}

enum JsMatch {
    Matched,
    NotMatched,
    Interrupted,
}

struct JavascriptRegex {
    // Declared first: a persistent handle must be released before the
    // context and runtime it belongs to.
    test: Persistent<Function<'static>>,
    _runtime: Runtime,
    context: Context,
    cancel: CancellationToken,
    interruption: Arc<RegexInterruption>,
}

#[cfg(test)]
thread_local! {
    /// Engines built on this thread; grep runs synchronously on its caller's
    /// thread, so a test can count one operation's compilations without
    /// seeing another test's.
    static COMPILATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
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
        #[cfg(test)]
        COMPILATIONS.with(|count| count.set(count.get() + 1));
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
        let test = context
            .with(|ctx| {
                ctx.eval::<(), _>(format!(
                    "globalThis.__mangoGrep = new RegExp({source}, {flags});"
                ))
                .catch(&ctx)
                .map_err(|error| error.to_string())?;
                // Compiled once so each line is a call, not a new program.
                ctx.eval::<Function, _>("(line) => __mangoGrep.test(line)")
                    .catch(&ctx)
                    .map(|test| Persistent::save(&ctx, test))
                    .map_err(|error| error.to_string())
            })
            .map_err(|error| {
                grep_pattern_error(format!("Invalid pattern \"{pattern}\": {error}"))
            })?;
        Ok(Self {
            test,
            _runtime: runtime,
            context,
            cancel,
            interruption,
        })
    }

    fn set_heap_limit(&self, heap_limit: usize) {
        self._runtime.set_memory_limit(heap_limit);
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
        match self.context.with(|ctx| {
            self.test
                .clone()
                .restore(&ctx)
                .and_then(|test| test.call::<_, bool>((line,)))
        }) {
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
    fn scannable_len_admits_only_non_empty_regular_files_within_the_size_limit() {
        let root = scratch_dir("filesystem-scannable-len");
        fs::write(root.join("empty.txt"), "").unwrap();
        fs::write(root.join("small.txt"), "abc").unwrap();
        fs::write(root.join("large.txt"), "abcdef").unwrap();
        let mut params = grep_params(&root, "x");
        params.max_file_size_bytes = 4;
        let len = |name: &str| scannable_len(&params, 0, || fs::metadata(root.join(name)));
        assert_eq!(len("small.txt"), Some(3), "small regular file");
        assert_eq!(len("empty.txt"), None, "empty file");
        assert_eq!(len("large.txt"), None, "file past max_file_size_bytes");
        assert_eq!(len("."), None, "directory");
        assert_eq!(len("missing.txt"), None, "missing file");
    }

    #[test]
    fn scannable_len_skips_without_reading_metadata_once_the_allowance_is_spent() {
        let root = scratch_dir("filesystem-scannable-len-allowance");
        let mut params = grep_params(&root, "x");
        params.max_results = 2;
        let unread = || -> std::io::Result<fs::Metadata> {
            panic!("metadata read although the result allowance is exhausted")
        };
        assert_eq!(scannable_len(&params, 2, unread), None);
        params.max_matches_per_file = 0;
        assert_eq!(scannable_len(&params, 0, unread), None);
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

    /// A pre-cancelled grep is refused before it compiles its policy, its
    /// pattern, or touches the path: the invalid pattern and missing root
    /// here would each fail differently if any of that work ran first.
    #[test]
    fn grep_refuses_a_pre_cancelled_call_before_any_work() {
        let root = scratch_dir("filesystem-search-precancel");
        let cancelled = token();
        cancelled.cancel();
        let params = grep_params(&root.join("missing"), "(unclosed");

        let refused = grep(params, &cancelled);
        let code = refused.as_ref().err().map(|error| error.code.clone());
        assert_eq!(
            code.as_deref(),
            Some(codes::CANCELLED),
            "expected a pre-cancelled grep refused as {} | received: {refused:?}",
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

    #[test]
    fn restricted_grep_still_reads_files_when_the_size_limit_is_usize_max() {
        let root = scratch_dir("filesystem-search-capability-max-size");
        fs::write(root.join("match.txt"), "needle\n").unwrap();
        let mut parameters = grep_params(&root, "needle");
        parameters.max_file_size_bytes = usize::MAX;
        parameters.path_policy = PathPolicy {
            allowed_roots: vec![root.to_path_buf()],
            ..PathPolicy::default()
        };
        assert_eq!(
            grep(parameters, &token()).unwrap()["matches"],
            json!([{ "file": "match.txt", "line": 1, "text": "needle" }]),
            "expected the match to survive an unbounded maxFileSizeBytes"
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
            let error = GrepMatcher::new(pattern, false, token()).err().unwrap();
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
    fn regexp_matches_each_line_passed_as_an_argument_verbatim() {
        let pattern = "^q\"\\\\\u{2028}x\\u0000$";
        let regex = JavascriptRegex::new(pattern, false, token(), quickjs_heap_limit(16)).unwrap();
        regex.start_file_budget(GREP_FILE_BUDGET);
        for (line, expected) in [
            ("q\"\\\u{2028}x\0", true),
            ("q\"\\\u{2028}x", false),
            ("q\"\\\u{2028}x\0", true),
        ] {
            let matched = matches!(regex.is_match(line).unwrap(), JsMatch::Matched);
            assert_eq!(matched, expected, "line {line:?} against {pattern:?}");
        }
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
        let mut matcher = GrepMatcher::new(&params.pattern, false, token()).unwrap();
        assert!(
            scan_file(
                &path,
                "slow.txt",
                &params,
                &params.path_policy.compile().unwrap(),
                &mut matcher,
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

    // ---- one engine per operation -------------------------------------------

    fn budgeted_matcher(pattern: &str, budget_ms: u64) -> GrepMatcher {
        GrepMatcher::with_file_budget(pattern, false, token(), Duration::from_millis(budget_ms))
            .unwrap()
    }

    fn compilations() -> usize {
        COMPILATIONS.with(std::cell::Cell::get)
    }

    /// Scans one in-memory file through a matcher shared with earlier files.
    fn scan(matcher: &mut GrepMatcher, params: &GrepParams, content: &[u8]) -> (bool, Vec<Value>) {
        let mut matches = Vec::new();
        let incomplete = scan_bytes(
            content.to_vec(),
            "file.txt",
            params,
            matcher,
            &token(),
            &mut matches,
        )
        .unwrap();
        (incomplete, matches)
    }

    fn matched_lines(matches: &[Value]) -> Vec<u64> {
        matches
            .iter()
            .map(|entry| entry["line"].as_u64().unwrap())
            .collect()
    }

    /// The engine's `(heap limit, live heap bytes)`.
    fn engine_memory(matcher: &GrepMatcher) -> (i64, i64) {
        let usage = matcher.engine.as_ref().unwrap()._runtime.memory_usage();
        (usage.malloc_limit, usage.malloc_size)
    }

    /// A file whose first line needs 6-8 MB of backtracking state under
    /// `^(?:a|b)*$`: past the ~4.8 MB a 100 KB file is given, within the
    /// ~12.8 MB this 1.1 MB file is given.
    fn heavy_line_in_a_large_file() -> Vec<u8> {
        let mut file = format!("{}\n", "a".repeat(100_000)).into_bytes();
        file.extend(std::iter::repeat_n(b'x', 1_000_000));
        file
    }

    #[test]
    fn a_grep_operation_compiles_its_pattern_once_for_every_candidate_file() {
        let root = scratch_dir("filesystem-search-compile-once");
        for index in 0..6 {
            fs::write(root.join(format!("file-{index}.txt")), "needle\nhay\n").unwrap();
        }
        fs::write(root.join("binary.bin"), b"needle\0").unwrap();

        let before = compilations();
        let result = grep(grep_params(&root, "needle"), &token()).unwrap();
        let compiled = compilations() - before;

        assert_eq!(result["filesScanned"], 7, "fixture must offer 7 candidates");
        assert_eq!(
            result["matches"].as_array().unwrap().len(),
            6,
            "fixture must match in each of the 6 text files"
        );
        assert_eq!(
            compiled, 1,
            "expected 1 engine compilation for 7 candidate files | received: {compiled}"
        );
    }

    #[test]
    fn a_single_file_grep_compiles_its_pattern_once() {
        let root = scratch_dir("filesystem-search-compile-once-file");
        fs::write(root.join("only.txt"), "needle\n").unwrap();
        let mut params = grep_params(&root.join("only.txt"), "needle");
        params.input_path = "only.txt".to_owned();

        let before = compilations();
        let result = grep(params, &token()).unwrap();
        let compiled = compilations() - before;

        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(
            compiled, 1,
            "expected 1 engine compilation for a single file | received: {compiled}"
        );
    }

    #[test]
    fn an_interrupted_file_costs_the_operation_one_more_compilation_not_one_per_file() {
        let params = grep_params(Path::new("."), "^(a+)+$");
        let mut matcher = budgeted_matcher(&params.pattern, 300);
        let before = compilations();

        let slow = format!("{}b", "a".repeat(50_000));
        assert!(scan(&mut matcher, &params, slow.as_bytes()).0);
        for _ in 0..3 {
            assert_eq!(matched_lines(&scan(&mut matcher, &params, b"aaa").1), [1]);
        }

        let rebuilt = compilations() - before;
        assert_eq!(
            rebuilt, 1,
            "expected 1 recompilation after the interrupted file | received: {rebuilt}"
        );
    }

    #[test]
    fn the_wall_clock_allowance_restarts_for_every_file() {
        let params = grep_params(Path::new("."), "needle");
        let mut matcher = budgeted_matcher("needle", 300);
        assert_eq!(
            matched_lines(&scan(&mut matcher, &params, b"needle").1),
            [1]
        );

        // The first file's allowance is spent while the next one is read.
        std::thread::sleep(Duration::from_millis(400));

        let (incomplete, matches) = scan(&mut matcher, &params, b"needle");
        assert!(
            !incomplete && matched_lines(&matches) == [1],
            "expected the second file to get its own 300ms allowance | received: \
             incomplete={incomplete} matches={matches:?}"
        );
    }

    #[test]
    fn recompiling_after_an_interruption_under_a_cancelled_token_reports_cancellation() {
        let cancel = token();
        let mut matcher = GrepMatcher::new("needle", false, cancel.clone()).unwrap();
        matcher.discard_engine();
        cancel.cancel();

        let outcome = matcher.for_file(6);

        let code = outcome.as_ref().err().map(|error| error.code.clone());
        assert_eq!(
            code.as_deref(),
            Some(codes::CANCELLED),
            "expected the recompilation refused as {} | received: {:?}",
            codes::CANCELLED,
            outcome.map(|_| "an engine").map_err(|error| error.message)
        );
    }

    #[test]
    fn a_timeout_on_one_file_still_lets_the_next_file_match() {
        let root = scratch_dir("filesystem-grep-timeout-then-match");
        let slow = root.join("slow.txt");
        let fast = root.join("fast.txt");
        fs::write(&slow, format!("aa\n{}b\n", "a".repeat(50_000))).unwrap();
        fs::write(&fast, "aaa\nbbb\n").unwrap();
        let params = grep_params(&root, "^(a+)+$");
        let policy = params.path_policy.compile().unwrap();
        let mut matcher = budgeted_matcher(&params.pattern, 300);
        let mut matches = Vec::new();

        let mut scan_one = |path: &Path, display: &str| {
            scan_file(
                path,
                display,
                &params,
                &policy,
                &mut matcher,
                &token(),
                &mut matches,
            )
            .unwrap()
        };
        let slow_incomplete = scan_one(&slow, "slow.txt");
        let fast_incomplete = scan_one(&fast, "fast.txt");

        assert!(
            slow_incomplete,
            "expected the catastrophic file to time out"
        );
        assert!(!fast_incomplete);
        assert_eq!(
            matches,
            vec![json!({ "file": "fast.txt", "line": 1, "text": "aaa" })],
            "expected only the file after the timeout to report a match"
        );
    }

    #[test]
    fn adversarial_expressions_time_out_their_file_and_never_poison_the_next() {
        for (pattern, slow_line) in [
            ("^(a+)+$", format!("{}b", "a".repeat(50_000))),
            ("(a|aa)+$", format!("{}b", "a".repeat(50_000))),
            ("^(?:a|b)*$", "a".repeat(400_000)),
        ] {
            let params = grep_params(Path::new("."), pattern);
            let mut matcher = budgeted_matcher(pattern, 300);

            let (_, leaked) = scan(&mut matcher, &params, slow_line.as_bytes());
            assert!(leaked.is_empty(), "{pattern}: partial matches leaked");
            let (incomplete, matches) = scan(&mut matcher, &params, b"aaa");

            assert!(!incomplete, "{pattern}: the next file must complete");
            assert_eq!(matched_lines(&matches), [1], "{pattern}: the next file");
        }
    }

    #[test]
    fn the_heap_limit_is_reset_to_each_files_size() {
        let mut matcher = GrepMatcher::new("x", false, token()).unwrap();
        for input_bytes in [10, 3_000_000, 0, 200_000_000, 10] {
            matcher.for_file(input_bytes).unwrap();
            assert_eq!(
                engine_memory(&matcher).0,
                i64::try_from(quickjs_heap_limit(input_bytes)).unwrap(),
                "expected the heap limit for a {input_bytes}-byte file"
            );
        }
    }

    #[test]
    fn heap_exhaustion_is_judged_against_the_current_files_size() {
        let small_file = "a".repeat(100_000).into_bytes();
        let params = grep_params(Path::new("."), "^(?:a|b)*$");
        let mut matcher = GrepMatcher::new(&params.pattern, false, token()).unwrap();

        assert_eq!(matched_lines(&scan(&mut matcher, &params, b"a").1), [1]);
        let (raised, matches) = scan(&mut matcher, &params, &heavy_line_in_a_large_file());
        assert!(
            !raised && matched_lines(&matches) == [1],
            "expected the large file to fit its raised heap limit | received: \
             incomplete={raised} matches={matches:?}"
        );

        let (lowered, matches) = scan(&mut matcher, &params, &small_file);
        assert!(
            lowered && matches.is_empty(),
            "expected the small file to exhaust the heap limit of its own size, not the \
             large file's | received: incomplete={lowered} matches={matches:?}"
        );
        assert_eq!(
            matched_lines(&scan(&mut matcher, &params, b"a").1),
            [1],
            "expected the next file to scan after heap exhaustion"
        );
    }

    #[test]
    fn a_large_file_leaves_no_residual_heap_for_the_next_file() {
        let params = grep_params(Path::new("."), "^(?:a|b)*$");
        let mut matcher = GrepMatcher::new(&params.pattern, false, token()).unwrap();
        matcher.for_file(2).unwrap();
        let (_, baseline) = engine_memory(&matcher);

        let large = heavy_line_in_a_large_file();
        assert_eq!(matched_lines(&scan(&mut matcher, &params, &large).1), [1]);

        let (_, residual) = engine_memory(&matcher);
        assert!(
            residual <= baseline + 64 * 1024,
            "expected the heap back at its {baseline}-byte baseline after a large file | \
             received: {residual} bytes"
        );
    }

    #[test]
    fn cancelling_interrupts_a_running_match_and_the_shared_engine_stays_cancelled() {
        let cancel = token();
        let mut matcher = GrepMatcher::new("^(a+)+$", false, cancel.clone()).unwrap();
        let regex = matcher.for_file(50_001).unwrap();
        let trigger = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            trigger.cancel();
        });
        let started = Instant::now();

        let outcome = regex.is_match(&format!("{}b", "a".repeat(50_000)));
        let elapsed = started.elapsed();
        canceller.join().unwrap();

        let code = outcome.as_ref().err().map(|error| error.code.clone());
        assert_eq!(
            code.as_deref(),
            Some(codes::CANCELLED),
            "expected the match cancelled as {} | received: {:?}",
            codes::CANCELLED,
            outcome.map(|_| "a completed match")
        );
        assert!(
            elapsed < GREP_FILE_BUDGET,
            "expected cancellation before the {GREP_FILE_BUDGET:?} file budget | received: {elapsed:?}"
        );
        let params = grep_params(Path::new("."), "x");
        let next = scan_bytes(
            b"x".to_vec(),
            "next.txt",
            &params,
            &mut matcher,
            &cancel,
            &mut Vec::new(),
        );
        assert_eq!(next.unwrap_err().code, codes::CANCELLED);
    }

    #[test]
    fn parallel_greps_share_no_engine_budget_or_cancellation() {
        let root = scratch_dir("filesystem-grep-parallel");
        fs::write(root.join("slow.txt"), format!("{}b\n", "a".repeat(50_000))).unwrap();
        fs::write(root.join("a.txt"), "needle\nhay\n").unwrap();
        fs::write(root.join("b.txt"), "Needle\n").unwrap();
        let cancelled = token();

        std::thread::scope(|scope| {
            let trigger = cancelled.clone();
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                trigger.cancel();
            });
            let doomed = scope.spawn(|| grep(grep_params(&root, "^(a+)+$"), &cancelled));
            let siblings: Vec<_> = (0..4)
                .map(|index| {
                    let root = root.to_path_buf();
                    scope.spawn(move || {
                        let mut params = grep_params(&root, "needle");
                        params.case_insensitive = index % 2 == 1;
                        let before = compilations();
                        let result = grep(params, &token()).unwrap();
                        (index, result, compilations() - before)
                    })
                })
                .collect();

            let outcome = doomed.join().unwrap();
            assert_eq!(
                outcome.as_ref().err().map(|error| error.code.as_str()),
                Some(codes::CANCELLED),
                "expected the cancelled grep to stop with {} | received: {:?}",
                codes::CANCELLED,
                outcome.as_ref().map(|_| "a result")
            );
            for sibling in siblings {
                let (index, result, compiled) = sibling.join().unwrap();
                let expected = if index % 2 == 1 { 2 } else { 1 };
                assert_eq!(
                    result["matches"].as_array().unwrap().len(),
                    expected,
                    "grep {index} must see only its own pattern and files"
                );
                assert_eq!(compiled, 1, "grep {index} engine compilations");
            }
        });
    }

    // ---- parity with the per-file engine (also run against the base) --------

    fn grep_lines(pattern: &str, case_insensitive: bool, content: &[u8]) -> Vec<u64> {
        let root = scratch_dir("filesystem-grep-parity");
        fs::write(root.join("case.txt"), content).unwrap();
        let mut params = grep_params(&root.join("case.txt"), pattern);
        params.input_path = "case.txt".to_owned();
        params.case_insensitive = case_insensitive;
        params.max_matches_per_file = 1_000;
        let result = grep(params, &token()).unwrap();
        matched_lines(result["matches"].as_array().unwrap())
    }

    #[test]
    fn parity_captures_and_lookarounds_follow_ecmascript() {
        for (pattern, content, expected) in [
            (r"(\w)\1", "book\nbok\nfoo", vec![1, 3]),
            (r"(?<y>\d{4})-\k<y>", "2020-2020\n2020-2021", vec![1]),
            (r"foo(?=bar)", "foobar\nfoobaz", vec![1]),
            (r"foo(?!bar)", "foobar\nfoobaz", vec![2]),
            (r"(?<=\$)\d+", "$12\n12", vec![1]),
            (r"(?<!\$)\b\d+", "$12\n12", vec![2]),
            (r"^(a|ab)(c|bcd)(d*)$", "abcd\nacd\nxbcd", vec![1, 2]),
        ] {
            assert_eq!(
                grep_lines(pattern, false, content.as_bytes()),
                expected,
                "pattern {pattern:?} over {content:?}"
            );
        }
    }

    #[test]
    fn parity_unicode_matches_utf16_code_units_without_the_u_flag() {
        for (pattern, ci, content, expected) in [
            ("^..$", false, "😀\né\nab", vec![1, 3]),
            ("^.$", false, "😀\né\nab", vec![2]),
            ("^[😀]$", false, "😀", vec![]),
            ("^[😀]{2}$", false, "😀", vec![1]),
            (r"^\u{1F600}$", false, "😀", vec![]),
            (r"^😀$", false, "😀", vec![1]),
            ("é", true, "É\ne", vec![1]),
            ("σ", true, "ς\nΣ", vec![1, 2]),
            ("k", true, "\u{212a}\nK", vec![2]),
            ("ß", true, "SS\nß", vec![2]),
            (r"^\w+$", false, "café\ncafe", vec![2]),
        ] {
            assert_eq!(
                grep_lines(pattern, ci, content.as_bytes()),
                expected,
                "pattern {pattern:?} (ignore case: {ci}) over {content:?}"
            );
        }
    }

    #[test]
    fn parity_line_terminators_and_invalid_utf8_are_matched_as_the_reader_yields_them() {
        assert_eq!(grep_lines("foo$", false, b"foo\r\nfoo\n"), vec![2]);
        assert_eq!(
            grep_lines("^foo.$", false, b"foo\r\nfoo\xe2\x80\xa8\n"),
            Vec::<u64>::new()
        );
        assert_eq!(grep_lines(r"^��$", false, b"\xff\xfe\nab"), vec![1]);
        assert_eq!(grep_lines("^$", false, b"a\n\nb\n"), vec![2, 4]);
    }

    #[test]
    fn parity_binary_detection_looks_only_at_the_first_8_kib() {
        let root = scratch_dir("filesystem-grep-parity-binary");
        fs::write(root.join("early.txt"), b"needle\0tail\n").unwrap();
        let mut late = vec![b'x'; 8 * 1024];
        late.extend_from_slice(b"\nneedle\0tail\n");
        fs::write(root.join("late.txt"), late).unwrap();

        let result = grep(grep_params(&root, "needle"), &token()).unwrap();

        assert_eq!(result["filesScanned"], 2);
        assert_eq!(
            result["matches"],
            json!([{ "file": "late.txt", "line": 2, "text": "needle\0tail" }])
        );
    }

    #[test]
    fn parity_invalid_patterns_are_refused_before_the_path_is_touched() {
        let root = scratch_dir("filesystem-grep-parity-invalid");
        for pattern in [
            "(",
            ")",
            "[b-a]",
            "a{2,1}",
            "*a",
            r"(?<n>a)(?<n>b)",
            r"(?<=a)+",
            "\\",
        ] {
            let error =
                grep(grep_params(&root.join("missing"), pattern), &token()).expect_err(pattern);
            assert_eq!(
                error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("kind")),
                Some(&json!("grep_pattern")),
                "pattern {pattern:?} must be refused as grep_pattern | received: {error:?}"
            );
        }
    }

    #[test]
    fn parity_deeply_nested_groups_stay_an_engine_result_on_a_small_stack() {
        let nested = format!("{}a{}", "(?:".repeat(240), ")".repeat(240));
        let outcome = std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                let root = scratch_dir("filesystem-grep-parity-nesting");
                fs::write(root.join("a.txt"), "a\nb\n").unwrap();
                grep(grep_params(&root, &nested), &token()).map(|result| result["matches"].clone())
            })
            .unwrap()
            .join()
            .expect("a deeply nested pattern must not overflow the thread stack");
        assert_eq!(
            outcome
                .as_ref()
                .ok()
                .map(|matches| matches.as_array().unwrap().len()),
            Some(1),
            "expected 1 match for the nested group | received: {outcome:?}"
        );
    }

    #[test]
    fn parity_multi_file_order_equals_the_files_scanned_one_by_one() {
        let root = scratch_dir("filesystem-grep-parity-order");
        fs::create_dir_all(root.join("deep/er")).unwrap();
        for (path, content) in [
            ("a.txt", "x1\nno\nx2\n"),
            ("b.txt", "no\n"),
            ("deep/c.txt", "x3\nx4\n"),
            ("deep/er/d.txt", "x5\n"),
            ("e.bin", "x6\0"),
        ] {
            fs::write(root.join(path), content).unwrap();
        }
        let mut params = grep_params(&root, r"x\d");
        params.max_matches_per_file = 1;
        let together = grep(params, &token()).unwrap();

        let mut one_by_one = Vec::new();
        for entry in together["matches"].as_array().unwrap() {
            let file = entry["file"].as_str().unwrap();
            let mut single = grep_params(&root.join(file), r"x\d");
            single.input_path = file.to_owned();
            single.max_matches_per_file = 1;
            let alone = grep(single, &token()).unwrap();
            // A lone file is displayed by its resolved path, not the directory's.
            let mut first = alone["matches"][0].clone();
            first["file"] = json!(file);
            one_by_one.push(first);
        }

        assert_eq!(together["filesScanned"], 5);
        assert_eq!(together["matches"].as_array().unwrap().len(), 3);
        assert_eq!(
            together["matches"].as_array().unwrap(),
            &one_by_one,
            "expected each file's first match alone to equal its place in the directory result"
        );
    }
}
