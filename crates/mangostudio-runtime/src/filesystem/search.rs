//! Synchronous, bounded glob and grep operations for the runtime filesystem.

use std::fs;
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

use super::io::{check_cancel, io_error, path_error, read};
use super::policy::PathPolicy;

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
    let absolute_pattern = Path::new(params.pattern.trim_start_matches('!')).is_absolute();
    let scan_root = if absolute_pattern {
        absolute_glob_root(params.pattern.trim_start_matches('!'))
    } else {
        params.cwd.clone()
    };
    let policy = params.path_policy.compile()?;
    policy.check(&params.cwd)?;
    policy.check(&scan_root)?;
    let matcher = compile_glob(&params.pattern, &params.cwd)?;
    let mut matches = Vec::with_capacity(params.max_results.min(5_000));
    let mut truncated = false;
    let mut candidates = 0;

    walk(&scan_root, cancel, |relative, absolute, is_directory| {
        candidates += 1;
        if candidates > MAX_CANDIDATES {
            truncated = true;
            return Ok(WalkControl::Stop);
        }
        if !params.include_dotfiles
            && hidden_path(relative)
            && !pattern_names_hidden(params.pattern.trim_start_matches("./"))
        {
            return Ok(WalkControl::Continue);
        }
        let relative_text = slash_path(if absolute_pattern { absolute } else { relative });
        if !matcher.is_match(&relative_text)
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
        matches.push(if params.absolute || absolute_pattern {
            absolute.to_string_lossy().into_owned()
        } else if params.pattern.starts_with("./") {
            format!(
                ".{}{}",
                std::path::MAIN_SEPARATOR,
                relative.to_string_lossy()
            )
        } else {
            relative.to_string_lossy().into_owned()
        });
        Ok(WalkControl::Continue)
    })
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
    let metadata = fs::metadata(&params.resolved_path)
        .map_err(|error| path_error(format!("Cannot access \"{}\": {error}", params.input_path)))?;
    let mut matches = Vec::with_capacity(params.max_results.min(5_000));
    let mut files_scanned = 0usize;
    let mut truncated = false;

    if metadata.is_file() {
        files_scanned = 1;
        truncated = scan_file(
            &params.resolved_path,
            &params.resolved_path.to_string_lossy(),
            &params.pattern,
            &params,
            cancel,
            &mut matches,
        )?;
    } else if metadata.is_dir() {
        let filter = params
            .glob
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("**/*");
        let file_matcher = compile_glob(filter, &params.resolved_path)?;
        let mut candidates = 0usize;
        walk(
            &params.resolved_path,
            cancel,
            |relative, absolute, is_directory| {
                candidates += 1;
                if candidates > MAX_CANDIDATES {
                    truncated = true;
                    return Ok(WalkControl::Stop);
                }
                if is_directory
                    || (!params.include_dotfiles
                        && hidden_path(relative)
                        && !pattern_names_hidden(filter))
                {
                    return Ok(WalkControl::Continue);
                }
                let relative_text = slash_path(relative);
                if !file_matcher.is_match(&relative_text) || !policy.allows(absolute) {
                    return Ok(WalkControl::Continue);
                }
                files_scanned += 1;
                if scan_file(
                    absolute,
                    &relative.to_string_lossy(),
                    &params.pattern,
                    &params,
                    cancel,
                    &mut matches,
                )? {
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

struct PathGlob {
    matcher: globset::GlobMatcher,
    negated: bool,
    depth: Option<usize>,
}

impl PathGlob {
    fn is_match(&self, path: &str) -> bool {
        if self
            .depth
            .is_some_and(|depth| path.split('/').count() != depth)
        {
            return false;
        }
        self.matcher.is_match(path) != self.negated
    }
}

fn absolute_glob_root(pattern: &str) -> PathBuf {
    let path = Path::new(pattern);
    let mut root = PathBuf::new();
    for component in path.components() {
        if component
            .as_os_str()
            .to_string_lossy()
            .contains(['*', '?', '[', '{'])
        {
            return root;
        }
        root.push(component);
    }
    root.parent().unwrap_or(path).to_path_buf()
}

fn compile_glob(pattern: &str, cwd: &Path) -> Result<PathGlob, RemoteError> {
    let positive = pattern.trim_start_matches('!');
    let negated = (pattern.len() - positive.len()) % 2 == 1;
    let normalized = positive.trim_start_matches("./").trim_end_matches('/');
    let mut builder = GlobBuilder::new(normalized);
    builder.literal_separator(true).backslash_escape(false);
    builder
        .build()
        .map(|glob| PathGlob {
            matcher: glob.compile_matcher(),
            negated,
            depth: (negated && !normalized.contains("**")).then(|| normalized.split('/').count()),
        })
        .map_err(|error| {
            path_error(format!(
                "Cannot evaluate pattern \"{pattern}\" in \"{}\": {error}",
                cwd.display()
            ))
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
    let observed = match read(absolute, metadata.len() as usize, cancel) {
        Ok(observed) => observed,
        // The file may disappear or become unreadable after metadata checked it.
        // Bun's scanner treats that as an empty completed scan, not a failed grep.
        Err(_) => {
            check_cancel(cancel)?;
            return Ok(false);
        }
    };
    if observed.bytes.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return Ok(false);
    }
    let content = String::from_utf8_lossy(&observed.bytes);
    let regex = JavascriptRegex::new(
        pattern,
        params.case_insensitive,
        cancel.clone(),
        quickjs_heap_limit(observed.bytes.len()),
    )?;
    regex.start_file_budget(GREP_FILE_BUDGET);
    let matches_before_file = matches.len();
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
    cancel: &CancellationToken,
    mut visit: impl FnMut(&Path, &Path, bool) -> Result<WalkControl, RemoteError>,
) -> Result<(), RemoteError> {
    let mut directories = vec![PathBuf::new()];
    while let Some(relative_directory) = directories.pop() {
        check_cancel(cancel)?;
        let absolute_directory = root.join(&relative_directory);
        let entries = fs::read_dir(&absolute_directory).map_err(io_error)?;
        for entry in entries {
            check_cancel(cancel)?;
            let entry = entry.map_err(io_error)?;
            let relative = relative_directory.join(entry.file_name());
            let absolute = root.join(&relative);
            let is_directory = entry.file_type().map_err(io_error)?.is_dir();
            if matches!(
                visit(&relative, &absolute, is_directory)?,
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

fn slash_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}

fn hidden_path(path: &Path) -> bool {
    path.components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}

fn pattern_names_hidden(pattern: &str) -> bool {
    pattern.split('/').any(|part| part.starts_with('.'))
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
        for (path, content) in [
            ("a.txt", "a"),
            ("b.md", "b"),
            (".hidden.txt", "h"),
            ("src/a.ts", "a"),
            ("src/.dot.ts", "d"),
            ("src/nested/b.ts", "b"),
        ] {
            fs::write(root.join(path), content).unwrap();
        }
        let result = glob(glob_params(&root, "**/*.ts"), &token()).unwrap();
        assert_eq!(result["matches"], json!(["src/a.ts", "src/nested/b.ts"]));
        let result = glob(glob_params(&root, "*.{txt,md}"), &token()).unwrap();
        let native_order: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name == "a.txt" || name == "b.md")
            .collect();
        assert_eq!(result["matches"], json!(native_order));
        let result = glob(glob_params(&root, "**/.dot.ts"), &token()).unwrap();
        assert_eq!(result["matches"], json!(["src/.dot.ts"]));
        let result = glob(glob_params(&root, "./*.txt"), &token()).unwrap();
        assert_eq!(
            result["matches"],
            json!([format!(".{}a.txt", std::path::MAIN_SEPARATOR)])
        );
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
