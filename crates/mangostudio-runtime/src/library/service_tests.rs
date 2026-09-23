//! The acceptance-named behaviours of the five read methods, exercised
//! through [`LibraryService`] with an injected path seam, clock and
//! filesystem — the Rust counterparts of
//! `apps/runtime/tests/unit/services/library/library-service.test.ts` plus
//! the cases the Rust host adds (remote isolation, relocated home, bounded
//! workers, capability truth).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use mango_protocol::error::codes;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::cache::LibraryCache;
use super::discovery::{LocationSettings, ScanDeps};
use super::fs::{FileMeta, LibraryFs, NativeLibraryFs, ReadFailure};
use super::service::{
    LibraryService, PathEnvOnlyParams, PathEnvParams, ReadParams, ReadTreeParams, ScanParams,
};
use super::tree::{TreeError, read_library_tree};
use crate::consent::source::ConsentSource;
use crate::probing::host::compose_runtime_path_env;
use crate::runtime_home::RuntimeSlot;
use crate::test_support::{ScratchDir, scratch_dir};

const SKILL: &str = "---\nname: alpha\ndescription: A skill.\n---\nbody\n";

struct Harness {
    service: LibraryService,
    clock: Arc<AtomicU64>,
    warnings: Arc<Mutex<Vec<String>>>,
    consent_home: ScratchDir,
}

/// A service whose `PathEnv` is this host's platform with `home` as the
/// home directory and `process_env` as the runtime's own environment —
/// the same composition `build_runtime_path_env` performs for real.
fn harness(home: &Path, process_env: &[(&str, &str)], fs: Arc<dyn LibraryFs>) -> Harness {
    let consent_home = scratch_dir("library-consent");
    let clock = Arc::new(AtomicU64::new(1));
    let warnings = Arc::new(Mutex::new(Vec::new()));
    let home = home.to_string_lossy().into_owned();
    let process_env: HashMap<String, String> = process_env
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect();
    let now = Arc::clone(&clock);
    let sink = Arc::clone(&warnings);
    Harness {
        service: LibraryService {
            consent: Arc::new(ConsentSource::new(
                RuntimeSlot::Host,
                consent_home.to_path_buf(),
            )),
            path_env: Arc::new(move |overrides| {
                compose_runtime_path_env(
                    process_env.clone(),
                    home.clone(),
                    crate::health::node_platform(),
                    overrides,
                )
            }),
            scan: ScanDeps {
                cache: Arc::new(LibraryCache::default()),
                fs,
                platform: crate::health::node_platform().to_string(),
                now_ms: Arc::new(move || now.load(Ordering::SeqCst)),
                warn: Arc::new(move |message: &str| sink.lock().unwrap().push(message.to_string())),
            },
        },
        clock,
        warnings,
        consent_home,
    }
}

fn write(path: &Path, contents: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn scan_params(settings: &[(&str, &str)], pins: Option<&[(&str, &str)]>) -> ScanParams {
    let mut location_settings = LocationSettings::new();
    for (scope, id) in settings {
        location_settings
            .entry((*scope).to_string())
            .or_default()
            .insert((*id).to_string(), true);
    }
    ScanParams {
        location_settings,
        force: None,
        kinds: None,
        location_path_overrides: None,
        path_env: pins.map(|pins| PathEnvParams {
            env: Some(
                pins.iter()
                    .map(|(k, v)| ((*k).into(), (*v).into()))
                    .collect(),
            ),
            workspace_root: None,
        }),
    }
}

fn slugs(result: &super::types::ScanResult) -> Vec<String> {
    let mut slugs: Vec<String> = result
        .entries
        .iter()
        .map(|entry| entry.resource.slug.clone())
        .collect();
    slugs.sort();
    slugs
}

fn skill_dir(root: &Path, slug: &str) -> PathBuf {
    let dir = root.join(slug);
    write(
        &dir.join("SKILL.md"),
        SKILL.replace("alpha", slug).as_bytes(),
    );
    dir
}

#[tokio::test]
async fn relocated_local_home_resolves_every_root_under_it() {
    let relocated = scratch_dir("library-relocated-home");
    skill_dir(&relocated.join(".mango/skills"), "moved");
    let harness = harness(&relocated, &[], Arc::new(NativeLibraryFs));
    let cancel = CancellationToken::new();

    let scanned = harness
        .service
        .scan(scan_params(&[], None), cancel.clone())
        .await
        .unwrap();
    assert_eq!(
        slugs(&scanned),
        ["moved"],
        "expected the relocated home's skill | received {:?}",
        slugs(&scanned)
    );

    let locations = harness
        .service
        .locations(PathEnvOnlyParams::default(), cancel.clone())
        .await
        .unwrap();
    let mango_skills = locations["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|location| location["id"] == "mango-skills")
        .unwrap();
    let expected = relocated.join(".mango").join("skills");
    assert_eq!(
        mango_skills["path"].as_str(),
        Some(expected.to_string_lossy().as_ref()),
        "expected mango-skills under the relocated home | received {}",
        mango_skills["path"]
    );
    assert_eq!(mango_skills["exists"], true);

    let sources = harness
        .service
        .settings_sources(PathEnvOnlyParams::default(), cancel)
        .await
        .unwrap();
    assert_eq!(
        sources["homeDir"].as_str(),
        Some(relocated.to_string_lossy().as_ref())
    );
}

/// The runtime's own `SKILLS_DIR` is honoured; a hub pin overrides it only
/// for the call that carries it; and an unpinned scan inside the memo TTL
/// never receives the pinned scan's answer.
#[tokio::test]
async fn remote_scans_never_inherit_hub_pins_or_share_their_memo() {
    let home = scratch_dir("library-remote-isolation");
    let runtime_skills = home.join("runtime-skills");
    let hub_skills = home.join("hub-skills");
    skill_dir(&runtime_skills, "runtime-own");
    skill_dir(&hub_skills, "hub-pinned");
    let runtime_dir = runtime_skills.to_string_lossy().into_owned();
    let hub_dir = hub_skills.to_string_lossy().into_owned();
    let harness = harness(
        &home,
        &[("SKILLS_DIR", &runtime_dir)],
        Arc::new(NativeLibraryFs),
    );
    let cancel = CancellationToken::new();

    let unpinned = harness
        .service
        .scan(scan_params(&[], None), cancel.clone())
        .await
        .unwrap();
    assert_eq!(
        slugs(&unpinned),
        ["runtime-own"],
        "expected the runtime's own SKILLS_DIR"
    );

    let pinned = harness
        .service
        .scan(
            scan_params(&[], Some(&[("SKILLS_DIR", &hub_dir)])),
            cancel.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        slugs(&pinned),
        ["hub-pinned"],
        "expected the pin to apply to its own call"
    );

    let again = harness
        .service
        .scan(scan_params(&[], None), cancel)
        .await
        .unwrap();
    assert_eq!(
        slugs(&again),
        ["runtime-own"],
        "expected an unpinned scan to stay on the runtime's own roots | received {:?}",
        slugs(&again)
    );
}

/// A cached scan is served inside the TTL even after the disk changed (the
/// TypeScript behaviour), recomputed once the TTL passes, and recomputed at
/// once under `force`.
#[tokio::test]
async fn scan_memo_invalidates_on_ttl_and_force() {
    let home = scratch_dir("library-cache-invalidation");
    let skills = home.join(".mango/skills");
    let dir = skill_dir(&skills, "alpha");
    let harness = harness(&home, &[], Arc::new(NativeLibraryFs));
    let cancel = CancellationToken::new();
    let hash = |result: &super::types::ScanResult| result.entries[0].instance.content_hash.clone();

    let first = harness
        .service
        .scan(scan_params(&[], None), cancel.clone())
        .await
        .unwrap();
    write(
        &dir.join("SKILL.md"),
        format!("{SKILL}changed and longer\n").as_bytes(),
    );

    harness.clock.store(1_000, Ordering::SeqCst);
    let memo = harness
        .service
        .scan(scan_params(&[], None), cancel.clone())
        .await
        .unwrap();
    assert_eq!(
        hash(&memo),
        hash(&first),
        "a scan inside the TTL must be the memo"
    );

    harness.clock.store(2_001, Ordering::SeqCst);
    let expired = harness
        .service
        .scan(scan_params(&[], None), cancel.clone())
        .await
        .unwrap();
    assert_ne!(
        hash(&expired),
        hash(&first),
        "a scan past the TTL must see the new bytes"
    );

    write(
        &dir.join("SKILL.md"),
        format!("{SKILL}third revision, longer still\n").as_bytes(),
    );
    let mut forced = scan_params(&[], None);
    forced.force = Some(true);
    let forced = harness.service.scan(forced, cancel).await.unwrap();
    assert_ne!(
        hash(&forced),
        hash(&expired),
        "force must bypass the memo inside the TTL"
    );
}

/// Counts reads so an unchanged fingerprint provably never reopens bytes
/// (`instance-reader.test.ts` "does not reopen unchanged content when the
/// instance fingerprint is cached").
struct CountingFs {
    reads: AtomicUsize,
}

impl LibraryFs for CountingFs {
    fn read_dir(&self, path: &Path) -> std::io::Result<Vec<OsString>> {
        NativeLibraryFs.read_dir(path)
    }
    fn real_path(&self, path: &Path) -> std::io::Result<PathBuf> {
        NativeLibraryFs.real_path(path)
    }
    fn stat(&self, path: &Path) -> std::io::Result<FileMeta> {
        NativeLibraryFs.stat(path)
    }
    fn read_file(
        &self,
        root: Option<&Path>,
        path: &Path,
        max: u64,
    ) -> Result<Vec<u8>, ReadFailure> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        NativeLibraryFs.read_file(root, path, max)
    }
}

#[tokio::test]
async fn an_unchanged_fingerprint_never_reopens_the_bytes() {
    let home = scratch_dir("library-fingerprint");
    skill_dir(&home.join(".mango/skills"), "alpha");
    let fs = Arc::new(CountingFs {
        reads: AtomicUsize::new(0),
    });
    let harness = harness(&home, &[], fs.clone());
    let cancel = CancellationToken::new();
    harness
        .service
        .scan(scan_params(&[], None), cancel.clone())
        .await
        .unwrap();
    let after_first = fs.reads.load(Ordering::SeqCst);
    harness.clock.store(10_000, Ordering::SeqCst);
    harness
        .service
        .scan(scan_params(&[], None), cancel)
        .await
        .unwrap();
    assert_eq!(
        fs.reads.load(Ordering::SeqCst),
        after_first,
        "expected the second scan to hit the instance memo | received extra reads"
    );
}

/// Malformed and oversized inputs are named invalid instances or failed
/// sources, never an empty successful answer.
#[tokio::test]
async fn corrupt_and_oversized_inputs_are_reported_not_dropped() {
    let home = scratch_dir("library-corrupt");
    write(&home.join(".claude/settings.json"), b"{\"unterminated\": ");
    write(
        &home.join(".codex/config.toml"),
        &vec![b'#'; 2 * 1024 * 1024 + 1],
    );
    write(
        &home.join(".mango/config.toml"),
        &vec![b'#'; 512 * 1024 + 1],
    );
    let harness = harness(&home, &[], Arc::new(NativeLibraryFs));
    let cancel = CancellationToken::new();

    let scanned = harness
        .service
        .scan(
            scan_params(
                &[("home", "claude-settings"), ("home", "codex-settings")],
                None,
            ),
            cancel.clone(),
        )
        .await
        .unwrap();
    let reason = |id: &str| {
        scanned
            .entries
            .iter()
            .find(|entry| entry.instance.location_id == id)
            .and_then(|entry| entry.instance.invalid_reason)
            .map(|reason| serde_json::to_value(reason).unwrap())
    };
    assert_eq!(
        reason("claude-settings"),
        Some(Value::from("invalid-metadata"))
    );
    assert_eq!(reason("codex-settings"), Some(Value::from("too-large")));

    let sources = harness
        .service
        .settings_sources(PathEnvOnlyParams::default(), cancel)
        .await
        .unwrap();
    let mango = sources["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|source| source["locationId"] == "mango-settings")
        .unwrap();
    assert_eq!(mango["present"], true);
    assert_eq!(mango["failureReason"], "too-large", "received {mango}");
}

/// The inherited silent case, pinned so a change to it is deliberate: an
/// existing location that cannot be listed contributes no rows but always
/// emits a diagnostic naming it.
#[tokio::test]
async fn an_unlistable_location_is_empty_but_diagnosed() {
    let home = scratch_dir("library-unlistable");
    write(
        &home.join(".claude/commands"),
        b"a file where a directory belongs",
    );
    let harness = harness(&home, &[], Arc::new(NativeLibraryFs));
    let scanned = harness
        .service
        .scan(
            scan_params(&[("home", "claude-commands")], None),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        scanned
            .entries
            .iter()
            .all(|entry| entry.instance.location_id != "claude-commands")
    );
    let warnings = harness.warnings.lock().unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("claude-commands")),
        "expected a skipped-location diagnostic | received {warnings:?}"
    );
}

fn read_params(path: &Path, location_id: &str) -> ReadParams {
    ReadParams {
        path: path.to_string_lossy().into_owned(),
        location_id: location_id.to_string(),
        path_env: None,
        max_bytes: None,
        truncate_oversize: None,
    }
}

/// `library-service.test.ts` "library.read resolves its own root from the
/// location": the single-file boundary is the agent home around it.
#[cfg(unix)]
#[tokio::test]
async fn read_containment_follows_the_location_not_the_request() {
    let home = scratch_dir("library-read-containment");
    let claude = home.join(".claude");
    write(&home.join("passwd"), b"root:x:0:0");
    write(&claude.join("shared.md"), b"shared");
    std::os::unix::fs::symlink(home.join("passwd"), claude.join("CLAUDE.md")).unwrap();
    let harness = harness(&home, &[], Arc::new(NativeLibraryFs));
    let cancel = CancellationToken::new();

    let escaped = harness
        .service
        .read(
            read_params(&claude.join("CLAUDE.md"), "claude-instructions"),
            cancel.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        escaped.denied,
        Some(true),
        "a symlink out of the agent home must be denied"
    );
    assert_eq!(escaped.content, "");

    std::fs::remove_file(claude.join("CLAUDE.md")).unwrap();
    std::os::unix::fs::symlink(claude.join("shared.md"), claude.join("CLAUDE.md")).unwrap();
    let inside = harness
        .service
        .read(
            read_params(&claude.join("CLAUDE.md"), "claude-instructions"),
            cancel.clone(),
        )
        .await
        .unwrap();
    assert_eq!((inside.denied, inside.content.as_str()), (None, "shared"));

    let elsewhere = harness
        .service
        .read(
            read_params(&home.join("passwd"), "claude-instructions"),
            cancel.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        elsewhere.denied,
        Some(true),
        "a path outside the named location must be denied"
    );

    let unknown = harness
        .service
        .read(
            read_params(&claude.join("CLAUDE.md"), "no-such-location"),
            cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        unknown.reason.as_deref(),
        Some("Library location \"no-such-location\" does not resolve on this machine.")
    );
}

#[tokio::test]
async fn read_argument_errors_are_tool_argument_errors() {
    let home = scratch_dir("library-read-arguments");
    let harness = harness(&home, &[], Arc::new(NativeLibraryFs));
    let mut params = read_params(Path::new(""), "claude-instructions");
    let error = harness
        .service
        .read(params, CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.details.unwrap()["kind"], "tool_argument");
    params = read_params(&home.join(".claude/CLAUDE.md"), "claude-instructions");
    params.max_bytes = Some(0.5);
    let error = harness
        .service
        .read(params, CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "library.read requires a positive integer maxBytes."
    );
}

/// A `LibraryFs` that cancels the call while a file read is in flight
/// (`library-service.test.ts` "refuses after a file read that was cancelled
/// while in flight").
struct CancellingFs {
    cancel: CancellationToken,
}

impl LibraryFs for CancellingFs {
    fn read_dir(&self, path: &Path) -> std::io::Result<Vec<OsString>> {
        NativeLibraryFs.read_dir(path)
    }
    fn real_path(&self, path: &Path) -> std::io::Result<PathBuf> {
        NativeLibraryFs.real_path(path)
    }
    fn stat(&self, path: &Path) -> std::io::Result<FileMeta> {
        NativeLibraryFs.stat(path)
    }
    fn read_file(
        &self,
        root: Option<&Path>,
        path: &Path,
        max: u64,
    ) -> Result<Vec<u8>, ReadFailure> {
        self.cancel.cancel();
        NativeLibraryFs.read_file(root, path, max)
    }
}

#[test]
fn read_tree_refuses_once_cancelled_mid_walk() {
    let home = scratch_dir("library-tree-cancel");
    let dir = skill_dir(&home.join("skills"), "alpha");
    write(&dir.join("second.md"), b"never returned");
    for (path, label) in [
        (dir.clone(), "directory"),
        (dir.join("SKILL.md"), "single file"),
    ] {
        let cancel = CancellationToken::new();
        let fs = CancellingFs {
            cancel: cancel.clone(),
        };
        let outcome = read_library_tree(
            &fs,
            &path.to_string_lossy(),
            &home.join("skills").to_string_lossy(),
            crate::health::node_platform(),
            &cancel,
        );
        assert_eq!(
            outcome,
            Err(TreeError::Cancelled),
            "{label}: expected a cancel during the first read to refuse the whole tree | received {outcome:?}"
        );
    }
}

#[tokio::test]
async fn every_method_refuses_a_call_cancelled_before_it_starts() {
    let home = scratch_dir("library-precancelled");
    let harness = harness(&home, &[], Arc::new(NativeLibraryFs));
    let cancel = CancellationToken::new();
    cancel.cancel();
    let service = &harness.service;
    let codes_seen = [
        service
            .scan(scan_params(&[], None), cancel.clone())
            .await
            .err()
            .map(|e| e.code),
        service
            .read(read_params(&home, "mango-skills"), cancel.clone())
            .await
            .err()
            .map(|e| e.code),
        service
            .read_tree(
                ReadTreeParams {
                    path: home.to_string_lossy().into(),
                    location_id: "mango-skills".into(),
                    path_env: None,
                },
                cancel.clone(),
            )
            .await
            .err()
            .map(|e| e.code),
        service
            .locations(PathEnvOnlyParams::default(), cancel.clone())
            .await
            .err()
            .map(|e| e.code),
        service
            .settings_sources(PathEnvOnlyParams::default(), cancel)
            .await
            .err()
            .map(|e| e.code),
    ];
    for code in codes_seen {
        assert_eq!(
            code.as_deref(),
            Some(codes::CANCELLED),
            "expected CANCELLED | received {code:?}"
        );
    }
}

/// Consent is re-read inside every call: withdrawing `library` between
/// calls refuses each method as a consent denial naming it, with no
/// filesystem work done (`consent-gate.test.ts` "re-reads consent on every
/// call so a mid-connection setup takes effect").
#[tokio::test]
async fn withdrawn_library_consent_refuses_every_read() {
    let home = scratch_dir("library-consent-withdrawn");
    let harness = harness(&home, &[], Arc::new(NativeLibraryFs));
    crate::runtime_home::write_runtime_slot_config(
        RuntimeSlot::Host,
        &harness.consent_home,
        &[("allow", Some(serde_json::json!({ "library": false })))],
    )
    .unwrap();
    let service = &harness.service;
    let cancel = CancellationToken::new();
    let tree = ReadTreeParams {
        path: home.to_string_lossy().into(),
        location_id: "mango-skills".into(),
        path_env: None,
    };
    let refusals = [
        service
            .scan(scan_params(&[], None), cancel.clone())
            .await
            .err(),
        service
            .read(read_params(&home, "mango-skills"), cancel.clone())
            .await
            .err(),
        service.read_tree(tree, cancel.clone()).await.err(),
        service
            .locations(PathEnvOnlyParams::default(), cancel.clone())
            .await
            .err(),
        service
            .settings_sources(PathEnvOnlyParams::default(), cancel)
            .await
            .err(),
    ];
    for refusal in refusals {
        let refusal = refusal.expect("a withdrawn capability must refuse the call");
        assert_eq!(
            refusal.code,
            codes::DENIED,
            "expected DENIED | received {refusal:?}"
        );
        assert_eq!(
            refusal.details.unwrap()["missing"],
            serde_json::json!(["library"])
        );
    }
}

/// The capability the hub reads must stay false while five of the ten
/// `library.*` methods are unregistered, and the five this lane owns must
/// be exactly the ones registered.
#[test]
fn partial_library_registration_never_advertises_the_feature() {
    let home = scratch_dir("library-capability");
    let registry = super::register(
        crate::registry::Registry::new(),
        ConsentSource::new(RuntimeSlot::Host, home.to_path_buf()),
    );
    let library_methods: Vec<&str> = mangostudio_runtime_contract::catalog::catalog()
        .methods
        .iter()
        .filter(|method| method.name.starts_with("library."))
        .map(|method| method.name.as_str())
        .collect();
    assert_eq!(
        library_methods.len(),
        10,
        "expected ten declared library methods | received {library_methods:?}"
    );
    let mut implemented = registry.implemented_methods();
    implemented.sort_unstable();
    assert_eq!(
        implemented,
        [
            "library.locations",
            "library.read",
            "library.read-tree",
            "library.scan",
            "library.settings-sources"
        ]
    );
    let allow = mangostudio_runtime_contract::manifest::RuntimeCapabilityAllow {
        fs_read: true,
        fs_write: true,
        shell: true,
        git: true,
        probing: true,
        mcp: true,
        library: true,
        checkpoints: true,
        update: true,
        external_agents: Some(true),
    };
    let features = crate::manifest::build_features(&registry, &allow, true);
    assert!(
        !features.library,
        "expected features.library false with 5 of 10 methods registered | received true"
    );
}
