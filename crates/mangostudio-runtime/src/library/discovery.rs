//! `library.scan`'s discovery half — `resolveLibraryScanTargets` and
//! `scanLibraryInstances` from `apps/shared/src/library/machine/discovery.ts`.
//!
//! Which locations a scan opens is decided by the hub's per-scope toggles
//! plus the two MangoStudio directories that are always on at home scope;
//! where each one is comes from this runtime's own [`PathEnv`] (or a
//! hub-supplied per-location override). The walk is one task per location,
//! owned by the scan memo rather than by any caller.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use mango_protocol::error::{RemoteError, codes};
use tokio_util::sync::CancellationToken;

use super::cache::LibraryCache;
use super::fs::LibraryFs;
use super::js::cmp_utf16;
use super::reader::{ScanContext, WalkError, read_location_instances};
use super::types::ScanResult;
use super::workers::run_library_blocking;
use crate::probing::detection::path_env::PathEnv;
use crate::probing::locations::{LOCATION_DEFINITIONS, LocationDefinition};

/// `ALWAYS_ENABLED_LIBRARY_LOCATIONS`: MangoStudio's own directories, on at
/// home scope whatever the toggles say.
const ALWAYS_ENABLED_LIBRARY_LOCATIONS: [&str; 2] = ["mango-skills", "mango-agents"];

/// The hub's per-scope location toggles (`LibraryLocationSettings`).
pub(crate) type LocationSettings = HashMap<String, HashMap<String, bool>>;

/// One location a scan will open, at its resolved absolute path.
#[derive(Debug, Clone)]
pub(crate) struct ScanTarget {
    pub location: &'static LocationDefinition,
    pub path: String,
}

/// `enabledLibraryLocations`.
#[must_use]
pub(crate) fn enabled_locations(settings: &LocationSettings, scope: &str) -> HashSet<String> {
    let mut enabled: HashSet<String> = settings
        .get(scope)
        .into_iter()
        .flatten()
        .filter(|(_, on)| **on)
        .map(|(id, _)| id.clone())
        .collect();
    if scope == "home" {
        enabled.extend(ALWAYS_ENABLED_LIBRARY_LOCATIONS.map(str::to_string));
    }
    enabled
}

/// `resolveLibraryScanTargets`, in registry order. An override replaces the
/// resolved path; an empty override (like an unresolvable location) skips
/// the location, as TypeScript's falsy-path check does.
///
/// # Example
///
/// ```ignore
/// let targets = resolve_scan_targets(&settings, &env, None, None);
/// assert_eq!(targets[0].location.id, "mango-skills");
/// ```
#[must_use]
pub(crate) fn resolve_scan_targets(
    settings: &LocationSettings,
    env: &PathEnv,
    kinds: Option<&[String]>,
    overrides: Option<&HashMap<String, String>>,
) -> Vec<ScanTarget> {
    let home = enabled_locations(settings, "home");
    let workspace = enabled_locations(settings, "workspace");
    LOCATION_DEFINITIONS
        .iter()
        .filter(|location| match location.scope {
            "home" => home.contains(location.id),
            _ => workspace.contains(location.id),
        })
        .filter(|location| kinds.is_none_or(|kinds| kinds.iter().any(|kind| kind == location.kind)))
        .filter_map(|location| {
            let path = match overrides.and_then(|overrides| overrides.get(location.id)) {
                Some(path) => Some(path.clone()),
                None => (location.resolve_path)(env),
            }?;
            (!path.is_empty()).then_some(ScanTarget { location, path })
        })
        .collect()
}

/// The memo key: every target's `scope\0id\0path`, sorted, so the same
/// location under two roots is two entries and a pinned remote scan never
/// shares one with an unpinned one.
#[must_use]
pub(crate) fn scan_signature(targets: &[ScanTarget]) -> String {
    let mut keys: Vec<String> = targets
        .iter()
        .map(|target| {
            format!(
                "{}\0{}\0{}",
                target.location.scope, target.location.id, target.path
            )
        })
        .collect();
    keys.sort_by(|left, right| cmp_utf16(left, right));
    format!("flat:\n{}", keys.join("\n"))
}

/// What a scan walk needs from its host; injected so tests can swap the
/// filesystem, clock, and diagnostic sink.
#[derive(Clone)]
pub(crate) struct ScanDeps {
    pub cache: Arc<LibraryCache>,
    pub fs: Arc<dyn LibraryFs>,
    pub platform: String,
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub warn: Arc<dyn Fn(&str) + Send + Sync>,
}

/// `scanLibraryInstances` with the scan memo on (the only mode the runtime
/// method uses): the flat instance list across every target, served from
/// the memo inside its TTL and coalesced across concurrent callers.
///
/// # Example
///
/// ```ignore
/// let scanned = scan_library(&deps, targets, force, &cancel).await?;
/// ```
pub(crate) async fn scan_library(
    deps: &ScanDeps,
    targets: Vec<ScanTarget>,
    force: bool,
    cancel: &CancellationToken,
) -> Result<ScanResult, RemoteError> {
    let signature = scan_signature(&targets);
    let walk_deps = deps.clone();
    let shared = deps
        .cache
        .scan(signature, (deps.now_ms)(), force, cancel, move || {
            walk_targets(walk_deps, targets, force)
        })
        .await?;
    shared.as_ref().clone()
}

async fn walk_targets(
    deps: ScanDeps,
    targets: Vec<ScanTarget>,
    force: bool,
) -> Result<ScanResult, RemoteError> {
    let jobs: Vec<_> = targets
        .into_iter()
        .map(|target| {
            let deps = deps.clone();
            tokio::spawn(run_library_blocking(move || {
                // The walk belongs to the memo, not to a caller: no caller's
                // cancellation reaches it (see `cache.rs`).
                let owned = CancellationToken::new();
                let warn = |message: &str| (deps.warn)(message);
                let context = ScanContext {
                    cache: &deps.cache,
                    force,
                    fs: deps.fs.as_ref(),
                    platform: &deps.platform,
                    cancel: &owned,
                    warn: &warn,
                };
                read_location_instances(target.location, &target.path, &context)
            }))
        })
        .collect();
    let mut result = ScanResult::default();
    for job in jobs {
        let scanned = job
            .await
            .map_err(|error| internal(format!("A library location walk failed: {error}.")))?
            .map_err(|error| match error {
                WalkError::Cancelled => internal("A library location walk was interrupted.".into()),
                other => internal(format!("A library location walk failed: {other:?}.")),
            })?;
        result.extend(scanned);
    }
    Ok(result)
}

fn internal(message: String) -> RemoteError {
    RemoteError::new(codes::INTERNAL, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(home: &str, pairs: &[(&str, &str)]) -> PathEnv {
        PathEnv {
            platform: "linux".into(),
            home_dir: home.into(),
            env: pairs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
        }
    }

    fn settings(pairs: &[(&str, &str, bool)]) -> LocationSettings {
        let mut settings = LocationSettings::new();
        for (scope, id, on) in pairs {
            settings
                .entry((*scope).into())
                .or_default()
                .insert((*id).into(), *on);
        }
        settings
    }

    fn ids(targets: &[ScanTarget]) -> Vec<&str> {
        targets.iter().map(|target| target.location.id).collect()
    }

    /// `library-discovery.test.ts` "always enables MangoStudio native
    /// locations even when a malformed map disables them" and "does not
    /// force MangoStudio native locations on under another scope".
    #[test]
    fn mango_locations_are_always_on_at_home_and_only_there() {
        let disabled = settings(&[
            ("home", "mango-skills", false),
            ("workspace", "claude-skills", true),
        ]);
        let targets = resolve_scan_targets(&disabled, &env("/h", &[]), None, None);
        assert_eq!(ids(&targets), ["mango-skills", "mango-agents"]);
        assert!(!enabled_locations(&disabled, "workspace").contains("mango-skills"));
    }

    #[test]
    fn kinds_and_overrides_narrow_the_targets() {
        let on = settings(&[
            ("home", "claude-agents", true),
            ("home", "claude-skills", true),
        ]);
        let skills_only = resolve_scan_targets(&on, &env("/h", &[]), Some(&["skill".into()]), None);
        assert_eq!(ids(&skills_only), ["mango-skills", "claude-skills"]);
        let overrides = HashMap::from([
            ("mango-skills".to_string(), "/elsewhere".to_string()),
            ("mango-agents".to_string(), String::new()),
        ]);
        let overridden = resolve_scan_targets(&on, &env("/h", &[]), None, Some(&overrides));
        assert_eq!(overridden[0].path, "/elsewhere");
        assert!(
            !ids(&overridden).contains(&"mango-agents"),
            "an empty override skips the location like a falsy path does"
        );
    }

    /// `scope-seam.test.ts` "does not serve one root a scan taken under
    /// another": distinct resolved roots are distinct signatures.
    #[test]
    fn signatures_partition_by_resolved_path() {
        let targets = |home: &str| {
            resolve_scan_targets(&LocationSettings::new(), &env(home, &[]), None, None)
        };
        assert_ne!(
            scan_signature(&targets("/a")),
            scan_signature(&targets("/b"))
        );
        assert_eq!(
            scan_signature(&targets("/a")),
            scan_signature(&targets("/a"))
        );
    }
}
