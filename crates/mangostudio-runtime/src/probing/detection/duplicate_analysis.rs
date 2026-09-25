//! `analyze_runtime_scan`, mirroring
//! `apps/shared/src/environments/detection/duplicate-analysis.ts`: turns a
//! raw [`super::binary_scan::RuntimeScanResult`] into the published
//! [`super::types::RuntimeStatus`] — health, and every finding
//! (not-found, installed-but-not-on-path, multiple-versions,
//! shadowed-by-earlier-path, version-below-minimum,
//! version-below-minimum-for, version-probe-failed).

use super::binary_scan::RuntimeDefinition;
use super::types::{
    ConsumerVersionRequirement, MinimumRuntimeVersion, RuntimeFinding, RuntimeFindingCode,
    RuntimeFindingSeverity, RuntimeHealth, RuntimeInstallation, RuntimeStatus, SemVer,
    VersionFloor, finding_params, wire_str,
};

/// Inputs [`analyze_runtime_scan`] needs beyond the scan itself.
pub struct RuntimeAnalysisOptions {
    /// Whether MangoStudio can offer an install recipe for this runtime.
    pub installable: bool,
    /// When this scan ran, in milliseconds since the Unix epoch.
    pub probed_at_ms: u64,
    /// A version floor every installation of this runtime is checked
    /// against.
    pub minimum_version: Option<MinimumRuntimeVersion>,
    /// Version floors that belong to a specific consumer of this runtime
    /// rather than the runtime itself, checked only against the
    /// installation that actually runs.
    pub consumer_requirements: Option<Vec<ConsumerVersionRequirement>>,
}

/// Whether a parsed version falls short of `floor`. A version the
/// definition could not parse is never "below" anything — an unreadable
/// version is its own finding
/// ([`RuntimeFindingCode::VersionProbeFailed`]), not a version claim — so
/// both floor checks below share this one answer.
fn is_below_floor(version: Option<SemVer>, floor: &impl VersionFloor) -> bool {
    match version {
        None => false,
        Some(version) => {
            version
                < SemVer {
                    major: floor.major(),
                    minor: floor.minor(),
                    patch: floor.patch(),
                }
        }
    }
}

fn format_version_floor(major: u32, minor: u32, patch: Option<u32>) -> String {
    match patch {
        Some(patch) => format!("{major}.{minor}.{patch}"),
        None => format!("{major}.{minor}"),
    }
}

/// Health is the worst severity carried by any finding; an absent
/// severity counts as `warn`.
fn health_for(
    installations_len: usize,
    failures_len: usize,
    findings: &[RuntimeFinding],
) -> RuntimeHealth {
    if installations_len == 0 {
        return if failures_len > 0 {
            RuntimeHealth::Error
        } else {
            RuntimeHealth::Missing
        };
    }
    if findings
        .iter()
        .any(|finding| finding.severity != Some(RuntimeFindingSeverity::Info))
    {
        RuntimeHealth::Warn
    } else {
        RuntimeHealth::Ok
    }
}

/// Builds the published [`RuntimeStatus`] for `definition` from `scan`,
/// mirroring `duplicate-analysis.ts`'s `analyzeRuntimeScan` exactly.
#[must_use]
pub fn analyze_runtime_scan(
    definition: &RuntimeDefinition,
    scan: &super::binary_scan::RuntimeScanResult,
    options: &RuntimeAnalysisOptions,
) -> RuntimeStatus {
    let mut findings: Vec<RuntimeFinding> = scan
        .failures
        .iter()
        .map(|failure| RuntimeFinding {
            code: failure.code,
            params: finding_params(&[("path", failure.path.clone())]),
            severity: None,
        })
        .collect();

    let canonical_installations: Vec<&RuntimeInstallation> = scan
        .installations
        .iter()
        .filter(|installation| installation.alias_of.is_none())
        .collect();
    let first_canonical = canonical_installations.first().copied();
    let effective = scan
        .installations
        .iter()
        .find(|installation| installation.effective);
    let effective_canonical = effective.and_then(|effective| {
        canonical_installations
            .iter()
            .find(|candidate| candidate.path == effective.path)
            .copied()
    });

    // A missing runtime and a broken candidate on PATH are different
    // facts, and a user can have both at once (no real install, plus a
    // dead shim). Neither should hide the other, so this does not gate on
    // `scan.failures` being empty — see this module's own mutation test.
    if first_canonical.is_none() {
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::NotFound,
            params: finding_params(&[("runtime", wire_str(&definition.id))]),
            severity: None,
        });
    }
    if let Some(first_canonical) = first_canonical
        && effective.is_none()
    {
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::InstalledButNotOnPath,
            params: finding_params(&[
                ("runtime", wire_str(&definition.id)),
                ("path", first_canonical.raw_path.clone()),
            ]),
            severity: None,
        });
    }

    for installation in &canonical_installations {
        if installation.version.is_some() {
            continue;
        }
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::VersionProbeFailed,
            params: finding_params(&[("path", installation.raw_path.clone())]),
            severity: None,
        });
    }

    let mut versions: Vec<String> = Vec::new();
    for installation in &canonical_installations {
        if let Some(version) = &installation.version
            && !versions.contains(version)
        {
            versions.push(version.clone());
        }
    }
    if versions.len() > 1 {
        findings.push(RuntimeFinding {
            code: RuntimeFindingCode::MultipleVersions,
            params: finding_params(&[
                ("runtime", wire_str(&definition.id)),
                ("versions", versions.join(", ")),
            ]),
            // Several installed versions is normal for anyone on a
            // version manager. `shadowed-by-earlier-path` is the finding
            // that fires when one of them is actually ambiguous — earlier
            // on PATH and different from what runs.
            severity: Some(RuntimeFindingSeverity::Info),
        });
    }

    if let Some(effective_canonical) = effective_canonical
        && effective_canonical.path_index.is_some()
    {
        // Always the first canonical installation onward, regardless of
        // which index `effective_canonical` itself sits at — this mirrors
        // `canonicalInstallations.slice(1)` in the TypeScript source
        // exactly, which is not "skip whichever one is effective" but
        // "skip the first one".
        for installation in canonical_installations.iter().skip(1) {
            let Some(path_index) = installation.path_index else {
                continue;
            };
            // Same version at two paths is a layout detail, not a
            // conflict. Only a version difference makes "which entry
            // comes first in PATH" actionable.
            if installation.version == effective_canonical.version {
                continue;
            }
            findings.push(RuntimeFinding {
                code: RuntimeFindingCode::ShadowedByEarlierPath,
                params: finding_params(&[
                    ("effectivePath", effective_canonical.raw_path.clone()),
                    (
                        "effectivePathIndex",
                        effective_canonical
                            .path_index
                            .expect("checked above")
                            .to_string(),
                    ),
                    ("shadowedPath", installation.raw_path.clone()),
                    ("shadowedPathIndex", path_index.to_string()),
                ]),
                severity: None,
            });
        }
    }

    if let Some(minimum_version) = &options.minimum_version {
        for installation in &canonical_installations {
            let Some(version_str) = &installation.version else {
                continue;
            };
            let version = (definition.parse_version)(version_str);
            if !is_below_floor(version, minimum_version) {
                continue;
            }
            findings.push(RuntimeFinding {
                code: RuntimeFindingCode::VersionBelowMinimum,
                params: finding_params(&[
                    ("path", installation.raw_path.clone()),
                    ("version", version_str.clone()),
                    (
                        "minimumVersion",
                        format_version_floor(
                            minimum_version.major,
                            minimum_version.minor,
                            minimum_version.patch,
                        ),
                    ),
                ]),
                // Only the binary that actually runs can make a feature
                // fail today; a stale install sitting below the floor is
                // detail, not a warning.
                severity: if installation.effective {
                    None
                } else {
                    Some(RuntimeFindingSeverity::Info)
                },
            });
        }
    }

    // Only the binary that runs can fail a consumer's floor, so its
    // version is parsed once here rather than per requirement.
    if let Some(consumer_requirements) = &options.consumer_requirements
        && let Some(effective) = effective
        && let Some(effective_version_str) = &effective.version
    {
        let effective_version = (definition.parse_version)(effective_version_str);
        for requirement in consumer_requirements {
            if !is_below_floor(effective_version, requirement) {
                continue;
            }
            findings.push(RuntimeFinding {
                code: RuntimeFindingCode::VersionBelowMinimumFor,
                params: finding_params(&[
                    ("consumer", requirement.consumer.clone()),
                    ("version", effective_version_str.clone()),
                    (
                        "minimumVersion",
                        format_version_floor(
                            requirement.major,
                            requirement.minor,
                            requirement.patch,
                        ),
                    ),
                ]),
                // A disabled consumer cannot fail on a version it never
                // runs against yet.
                severity: if requirement.enabled {
                    None
                } else {
                    Some(RuntimeFindingSeverity::Info)
                },
            });
        }
    }

    RuntimeStatus {
        id: definition.id,
        health: health_for(scan.installations.len(), scan.failures.len(), &findings),
        installations: scan.installations.clone(),
        effective: effective.cloned(),
        findings,
        installable: options.installable,
        probed_at_ms: options.probed_at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::super::binary_scan::RuntimeScanResult;
    use super::super::types::{PathSource, RuntimeId, RuntimeOrigin};
    use super::*;

    fn definition() -> RuntimeDefinition {
        RuntimeDefinition {
            id: RuntimeId::Node,
            binary_names: &["node"],
            version_args: &["--version"],
            parse_version: |raw| {
                let mut parts = raw.trim_start_matches('v').splitn(3, '.');
                Some(SemVer {
                    major: parts.next()?.parse().ok()?,
                    minor: parts.next()?.parse().ok()?,
                    patch: parts.next()?.parse().ok()?,
                })
            },
            keep_unparsed_version: false,
            well_known_dirs: |_| Vec::new(),
            include_bare_binary_names: false,
            shared_binary_names: &[],
        }
    }

    fn installation(
        path: &str,
        version: Option<&str>,
        path_index: Option<u32>,
        effective: bool,
    ) -> RuntimeInstallation {
        RuntimeInstallation {
            path: path.to_string(),
            raw_path: path.to_string(),
            version: version.map(str::to_string),
            origin: RuntimeOrigin::Path,
            path_index,
            effective,
            alias_of: None,
            managed_by: None,
            path_source: Some(PathSource::System),
        }
    }

    fn base_options() -> RuntimeAnalysisOptions {
        RuntimeAnalysisOptions {
            installable: true,
            probed_at_ms: 1_785_000_000_000,
            minimum_version: None,
            consumer_requirements: None,
        }
    }

    #[test]
    fn no_installations_and_no_failures_is_missing_with_a_not_found_finding() {
        let scan = RuntimeScanResult::default();
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        assert_eq!(status.health, RuntimeHealth::Missing);
        assert_eq!(status.findings.len(), 1);
        assert_eq!(status.findings[0].code, RuntimeFindingCode::NotFound);
    }

    /// Mutation test 2: reinstate the old `scan.failures.length === 0`
    /// gate around the `not-found` push and this goes red — the pre-fix
    /// failure, pasted verbatim from a local run with that gate restored:
    ///
    /// ```text
    /// thread 'probing::detection::duplicate_analysis::tests::a_broken_path_shim_and_no_real_install_both_report_neither_hiding_the_other' panicked at crates/mangostudio-runtime/src/probing/detection/duplicate_analysis.rs:...:
    /// assertion `left == right` failed
    ///   left: [NotExecutable]
    ///  right: [NotExecutable, NotFound]
    /// ```
    #[test]
    fn a_broken_path_shim_and_no_real_install_both_report_neither_hiding_the_other() {
        let scan = RuntimeScanResult {
            installations: Vec::new(),
            failures: vec![super::super::binary_scan::RuntimeScanFailure {
                code: RuntimeFindingCode::NotExecutable,
                path: "/broken/bin/node".to_string(),
            }],
        };
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        let codes: Vec<RuntimeFindingCode> =
            status.findings.iter().map(|finding| finding.code).collect();
        assert_eq!(
            codes,
            vec![
                RuntimeFindingCode::NotExecutable,
                RuntimeFindingCode::NotFound
            ]
        );
        assert_eq!(status.health, RuntimeHealth::Error);
    }

    #[test]
    fn installed_but_not_effective_raises_installed_but_not_on_path() {
        let scan = RuntimeScanResult {
            installations: vec![installation(
                "/well-known/node",
                Some("22.13.0"),
                None,
                false,
            )],
            failures: Vec::new(),
        };
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        assert!(
            status
                .findings
                .iter()
                .any(|finding| finding.code == RuntimeFindingCode::InstalledButNotOnPath)
        );
    }

    #[test]
    fn an_effective_installation_raises_no_installed_but_not_on_path_finding() {
        let scan = RuntimeScanResult {
            installations: vec![installation(
                "/usr/bin/node",
                Some("22.13.0"),
                Some(0),
                true,
            )],
            failures: Vec::new(),
        };
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        assert!(
            !status
                .findings
                .iter()
                .any(|finding| finding.code == RuntimeFindingCode::InstalledButNotOnPath)
        );
        assert_eq!(status.health, RuntimeHealth::Ok);
    }

    #[test]
    fn an_unparsed_version_raises_version_probe_failed() {
        let scan = RuntimeScanResult {
            installations: vec![installation("/usr/bin/node", None, Some(0), true)],
            failures: Vec::new(),
        };
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        assert!(
            status
                .findings
                .iter()
                .any(|finding| finding.code == RuntimeFindingCode::VersionProbeFailed)
        );
    }

    #[test]
    fn more_than_one_distinct_version_raises_an_info_severity_multiple_versions_finding() {
        // The second installation is discovered off `PATH` (no
        // `path_index`), so it cannot also trigger
        // `shadowed-by-earlier-path` — that finding needs a `PATH`
        // position to compare, and this test isolates `multiple-versions`
        // on its own.
        let scan = RuntimeScanResult {
            installations: vec![
                installation("/a/node", Some("20.11.0"), Some(0), true),
                installation("/b/node", Some("22.13.0"), None, false),
            ],
            failures: Vec::new(),
        };
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        let finding = status
            .findings
            .iter()
            .find(|finding| finding.code == RuntimeFindingCode::MultipleVersions)
            .expect("multiple-versions finding");
        assert_eq!(finding.severity, Some(RuntimeFindingSeverity::Info));
        assert!(
            !status
                .findings
                .iter()
                .any(|finding| finding.code == RuntimeFindingCode::ShadowedByEarlierPath)
        );
        // `info` severity never escalates health.
        assert_eq!(status.health, RuntimeHealth::Ok);
    }

    #[test]
    fn a_shadowed_earlier_path_with_a_different_version_is_reported() {
        let scan = RuntimeScanResult {
            installations: vec![
                installation("/a/node", Some("20.11.0"), Some(0), true),
                installation("/b/node", Some("22.13.0"), Some(1), false),
            ],
            failures: Vec::new(),
        };
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        let finding = status
            .findings
            .iter()
            .find(|finding| finding.code == RuntimeFindingCode::ShadowedByEarlierPath)
            .expect("shadowed finding");
        assert_eq!(
            finding.params.as_ref().unwrap().get("shadowedPath"),
            Some(&"/b/node".to_string())
        );
        assert_eq!(status.health, RuntimeHealth::Warn);
    }

    #[test]
    fn the_same_version_at_two_paths_is_not_reported_as_shadowed() {
        let scan = RuntimeScanResult {
            installations: vec![
                installation("/a/node", Some("22.13.0"), Some(0), true),
                installation("/b/node", Some("22.13.0"), Some(1), false),
            ],
            failures: Vec::new(),
        };
        let status = analyze_runtime_scan(&definition(), &scan, &base_options());
        assert!(
            !status
                .findings
                .iter()
                .any(|finding| finding.code == RuntimeFindingCode::ShadowedByEarlierPath)
        );
    }

    #[test]
    fn a_version_below_the_floor_is_info_severity_when_it_is_not_the_effective_installation() {
        let scan = RuntimeScanResult {
            installations: vec![
                installation("/a/node", Some("22.13.0"), Some(0), true),
                installation("/old/node", Some("18.0.0"), None, false),
            ],
            failures: Vec::new(),
        };
        let mut options = base_options();
        options.minimum_version = Some(MinimumRuntimeVersion {
            major: 20,
            minor: 0,
            patch: None,
        });
        let status = analyze_runtime_scan(&definition(), &scan, &options);
        let finding = status
            .findings
            .iter()
            .find(|finding| finding.code == RuntimeFindingCode::VersionBelowMinimum)
            .expect("below-minimum finding");
        assert_eq!(finding.severity, Some(RuntimeFindingSeverity::Info));
    }

    #[test]
    fn a_version_below_the_floor_carries_no_severity_when_it_is_the_effective_installation() {
        let scan = RuntimeScanResult {
            installations: vec![installation("/a/node", Some("18.0.0"), Some(0), true)],
            failures: Vec::new(),
        };
        let mut options = base_options();
        options.minimum_version = Some(MinimumRuntimeVersion {
            major: 20,
            minor: 0,
            patch: None,
        });
        let status = analyze_runtime_scan(&definition(), &scan, &options);
        let finding = status
            .findings
            .iter()
            .find(|finding| finding.code == RuntimeFindingCode::VersionBelowMinimum)
            .expect("below-minimum finding");
        assert_eq!(finding.severity, None);
        assert_eq!(status.health, RuntimeHealth::Warn);
    }

    #[test]
    fn an_unparsed_version_is_never_reported_below_the_floor() {
        let scan = RuntimeScanResult {
            installations: vec![installation("/a/node", None, Some(0), true)],
            failures: Vec::new(),
        };
        let mut options = base_options();
        options.minimum_version = Some(MinimumRuntimeVersion {
            major: 20,
            minor: 0,
            patch: None,
        });
        let status = analyze_runtime_scan(&definition(), &scan, &options);
        assert!(
            !status
                .findings
                .iter()
                .any(|finding| finding.code == RuntimeFindingCode::VersionBelowMinimum)
        );
    }

    #[test]
    fn a_disabled_consumer_below_its_own_floor_is_info_severity() {
        let scan = RuntimeScanResult {
            installations: vec![installation("/a/node", Some("18.0.0"), Some(0), true)],
            failures: Vec::new(),
        };
        let mut options = base_options();
        options.consumer_requirements = Some(vec![ConsumerVersionRequirement {
            major: 20,
            minor: 0,
            patch: None,
            consumer: "claude".to_string(),
            enabled: false,
        }]);
        let status = analyze_runtime_scan(&definition(), &scan, &options);
        let finding = status
            .findings
            .iter()
            .find(|finding| finding.code == RuntimeFindingCode::VersionBelowMinimumFor)
            .expect("consumer finding");
        assert_eq!(finding.severity, Some(RuntimeFindingSeverity::Info));
    }

    #[test]
    fn an_enabled_consumer_below_its_own_floor_carries_no_severity() {
        let scan = RuntimeScanResult {
            installations: vec![installation("/a/node", Some("18.0.0"), Some(0), true)],
            failures: Vec::new(),
        };
        let mut options = base_options();
        options.consumer_requirements = Some(vec![ConsumerVersionRequirement {
            major: 20,
            minor: 0,
            patch: None,
            consumer: "claude".to_string(),
            enabled: true,
        }]);
        let status = analyze_runtime_scan(&definition(), &scan, &options);
        let finding = status
            .findings
            .iter()
            .find(|finding| finding.code == RuntimeFindingCode::VersionBelowMinimumFor)
            .expect("consumer finding");
        assert_eq!(finding.severity, None);
    }

    #[test]
    fn format_version_floor_omits_patch_when_unset() {
        assert_eq!(format_version_floor(20, 0, None), "20.0");
        assert_eq!(format_version_floor(20, 0, Some(3)), "20.0.3");
    }
}
