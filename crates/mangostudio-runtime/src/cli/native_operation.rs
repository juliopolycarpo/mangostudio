//! Native slot installation and local CLI reports. Filesystem work stays outside Tokio.

use std::fs::{self, File};
use std::io::{self, BufRead, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{AuditArgs, EnvSource, InstallArgs, ServiceAction, ServiceArgs};
use crate::runtime_home::{
    RuntimeSlot, read_runtime_slot_config, resolve_runtime_slot_for_current_exe,
    slot_audit_log_path, slot_current_binary_path, slot_dir, slot_for_path,
    slot_version_binary_path, write_runtime_slot_config,
};
use crate::slot_publish::{
    BinaryPublication, activate_slot_current, prune_slot_versions, publish_slot_binary,
    read_slot_current, restore_slot_current, validate_slot_version,
};
use crate::slot_update_lock::SlotUpdateLock;

mod user_service;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    slot: &'static str,
    version: String,
    digest: String,
    binary_path: String,
    current_binary_path: String,
    replaced_version: Option<String>,
    unchanged: bool,
}

/// Installs one immutable binary under a slot and rolls back `current` if config writing fails.
///
/// ```ignore
/// let result = install_source(Path::new("/tmp/runtime"), RuntimeSlot::Remote, "1.2.0", home)?;
/// ```
fn install_source(
    source: &Path,
    slot: RuntimeSlot,
    version: &str,
    home: &Path,
) -> io::Result<InstallResult> {
    validate_slot_version(version)?;
    let root = slot_dir(slot, home);
    if slot_for_path(source, home).is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "binary {} already runs from a runtime slot; expected an external source binary",
                source.display()
            ),
        ));
    }
    let digest = digest_file(source)?;
    let _claim = SlotUpdateLock::acquire(
        &root,
        format!("install-{}", std::process::id()),
        Duration::from_secs(120),
    )?;
    let previous = read_slot_current(&root)?;
    let stored = read_runtime_slot_config(slot, home);
    if let Some(error) = stored.error.as_ref() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("cannot install over invalid slot config: {error}"),
        ));
    }
    let existing_binary = slot_version_binary_path(slot, version, home);
    let unchanged = previous.as_deref() == Some(version)
        && stored.stored_string("version").as_deref() == Some(version)
        && stored.stored_string("digest").as_deref() == Some(digest.as_str())
        && digest_file(&existing_binary).is_ok_and(|actual| actual == digest);
    if !unchanged {
        let publication = publish_slot_binary(&root, version, source)?;
        if digest_file(&existing_binary)? != digest {
            if publication == BinaryPublication::Published {
                let _ = fs::remove_file(&existing_binary);
            }
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "published binary {} does not match source digest {digest}; expected identical bytes",
                    existing_binary.display()
                ),
            ));
        }
        let activated = activate_slot_current(&root, version)?;
        let binary = slot_version_binary_path(slot, version, home);
        let update = [
            ("version", Some(Value::String(version.to_owned()))),
            (
                "binaryPath",
                Some(Value::String(binary.to_string_lossy().into_owned())),
            ),
            ("digest", Some(Value::String(digest.clone()))),
        ];
        if let Err(error) = write_runtime_slot_config(slot, home, &update) {
            restore_slot_current(&root, activated.as_deref())?;
            return Err(io::Error::other(error));
        }
        let _ = prune_slot_versions(&root, version, previous.as_deref());
    }
    let binary = slot_version_binary_path(slot, version, home);
    Ok(InstallResult {
        slot: slot.as_str(),
        version: version.to_owned(),
        digest,
        binary_path: binary.to_string_lossy().into_owned(),
        current_binary_path: slot_current_binary_path(slot, home)
            .to_string_lossy()
            .into_owned(),
        replaced_version: previous.filter(|old| old != version),
        unchanged,
    })
}

fn digest_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut sha = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let len = file.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        sha.update(&buffer[..len]);
    }
    Ok(format!(
        "sha256:{}",
        sha.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

pub(super) fn run_install(args: InstallArgs, env: &impl EnvSource, version: &str) -> i32 {
    let result = super::mango_home(env).and_then(|home| {
        std::env::current_exe()
            .and_then(|source| install_source(&source, args.slot, version, &home))
    });
    match result {
        Ok(result) => {
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string(&result).expect("install result serializes")
                );
            } else {
                println!(
                    "Installed {} into the {} slot at {}.\nLaunch it through {}.\n\nNext:\n  mangostudio-runtime setup --slot {}\n  mangostudio-runtime connect --hub <url>   # or: serve --listen <host:port>\n  mangostudio-runtime service install",
                    result.version,
                    result.slot,
                    result.binary_path,
                    result.current_binary_path,
                    result.slot
                );
            }
            0
        }
        Err(error) => report_error(args.json, &error.to_string()),
    }
}

pub(super) fn health_value_for(slot: RuntimeSlot, home: &Path, version: &str) -> io::Result<Value> {
    let runtime = super::build_runtime()?;
    let result = runtime.block_on(crate::health::build_health_report(
        slot,
        home,
        version,
        &tokio_util::sync::CancellationToken::new(),
        None,
    ));
    runtime.shutdown_timeout(Duration::from_secs(2));
    result.map_err(|error| io::Error::other(format!("runtime.health failed: {error}")))
}

fn health_value(home: &Path, version: &str) -> io::Result<Value> {
    health_value_for(resolve_runtime_slot_for_current_exe(home), home, version)
}

pub(super) fn run_health(json_output: bool, env: &impl EnvSource, version: &str) -> i32 {
    let Some(home) = super::mango_home_or_report(env) else {
        return 1;
    };
    let report = match health_value(&home, version) {
        Ok(report) => report,
        Err(error) => return report_error(json_output, &error.to_string()),
    };
    if json_output {
        println!("{report}");
    } else {
        println!(
            "slot        {}\nversion     {}\nbinary      {}\ndigest      {}\nprofile     {} ({})\naudit       {}",
            report["slot"].as_str().unwrap_or("?"),
            version,
            report["binaryPath"].as_str().unwrap_or("-"),
            report["digest"].as_str().unwrap_or("-"),
            report["profile"].as_str().unwrap_or("?"),
            report["setup"]["state"].as_str().unwrap_or("?"),
            if report["audit"]["enabled"] == true {
                "on"
            } else {
                "off"
            }
        );
    }
    0
}

pub(super) fn run_doctor(json_output: bool, env: &impl EnvSource, version: &str) -> i32 {
    let Some(home) = super::mango_home_or_report(env) else {
        return 1;
    };
    let report = match health_value(&home, version) {
        Ok(report) => report,
        Err(error) => return report_error(json_output, &error.to_string()),
    };
    let slot = report["slot"].as_str().unwrap_or("remote");
    let audit_error = read_audit_error(slot.parse().unwrap_or(RuntimeSlot::Remote), &home);
    let mut findings = health_findings(&report, audit_error.as_deref());
    findings.extend(slot_findings(&report, &home));
    if slot == "remote" {
        let config = read_runtime_slot_config(RuntimeSlot::Remote, &home);
        let paired = config.stored_string("hubUrl").is_some()
            || config.stored_string("serveListen").is_some();
        if paired {
            findings.extend(service_findings(&user_service::run(
                ServiceAction::Status,
                None,
                false,
                &home,
            )));
        }
    }
    let failed = findings.iter().any(|finding| finding["severity"] == "fail");
    if json_output {
        println!("{}", json!({"health":report,"findings":findings}));
    } else {
        for finding in &findings {
            println!(
                "{}  {}  {}",
                finding["severity"].as_str().unwrap_or("?"),
                finding["title"].as_str().unwrap_or("?"),
                finding["detail"].as_str().unwrap_or("?")
            );
        }
    }
    i32::from(failed)
}

/// The last audit write failure `slot`'s sink left in its sidecar
/// `audit.log.error`, or `None` when the last write landed (a successful
/// write removes the sidecar) or nothing was ever written.
fn read_audit_error(slot: RuntimeSlot, home: &Path) -> Option<String> {
    let mut path = slot_audit_log_path(slot, home).into_os_string();
    path.push(".error");
    let message = fs::read_to_string(PathBuf::from(path)).ok()?;
    let message = message.trim();
    (!message.is_empty()).then(|| message.to_owned())
}

/// What `doctor` concludes from a `runtime.health` report plus the audit
/// sink's last write failure. Mirrors the operator-actionable part of
/// `health.ts`'s `diagnoseRuntimeHealth`: the config error, consent, a
/// config that records another version than this binary, and an audit
/// log that stopped landing. The version finding names no fix: unlike
/// `setup.ts`, this crate's `setup` command does not rewrite `version`.
/// Only the launch that records consent on a first answer does
/// (`consent::invocation`), so no command an operator runs resyncs it.
///
/// Usage: `health_findings(&report, None)` for a slot whose audit writes land.
fn health_findings(report: &Value, audit_error: Option<&str>) -> Vec<Value> {
    let mut findings = Vec::new();
    let slot = report["slot"].as_str().unwrap_or("remote");
    // Names `--profile`: this crate's `setup` never prompts, so a bare
    // `setup --slot <slot>` only answers "Nothing to answer with".
    let setup = crate::consent::invocation::setup_command(slot.parse().ok());
    if let Some(error) = report["lastError"].as_str() {
        findings.push(json!({"severity":"fail","title":"Config","detail":error,"fix":setup}));
    }
    if report["setup"]["state"] == "pending" {
        findings.push(
            json!({"severity":"fail","title":"Consent","detail":"setup is pending","fix":setup}),
        );
    } else {
        findings.push(json!({"severity":"ok","title":"Consent","detail":"configured"}));
    }
    if let (Some(recorded), Some(running)) = (
        report["version"].as_str(),
        report["runtimeVersion"].as_str(),
    ) && recorded != running
    {
        findings.push(json!({"severity":"warn","title":"Version","detail":format!("the config records {recorded} but this binary is {running}; the install was replaced without updating the config")}));
    }
    // Only while audit is on, as `health.ts` gates `readRuntimeAuditError`:
    // a sidecar left from an earlier enabled period is not a current fault.
    if report["audit"]["enabled"] == true
        && let Some(error) = audit_error
    {
        findings.push(json!({"severity":"warn","title":"Audit","detail":format!("the last audit write failed: {error}")}));
    }
    findings
}

/// What `doctor` concludes about the slot's `current` pointer.
fn slot_findings(report: &Value, home: &Path) -> Vec<Value> {
    let mut findings = Vec::new();
    let slot = report["slot"].as_str().unwrap_or("remote");
    let root = slot_dir(slot.parse().unwrap_or(RuntimeSlot::Remote), home);
    match read_slot_current(&root) {
        Ok(Some(version)) => {
            let binary = root.join(&version).join(crate::runtime_home::binary_name());
            if !binary.is_file() {
                findings.push(json!({"severity":"fail","title":"Slot","detail":format!("current points to {version}, but {} is missing",binary.display()),"fix":format!("mangostudio-runtime install --slot {slot}")}));
            }
        }
        Ok(None) if slot == "remote" && report["version"].is_string() => {
            findings.push(json!({"severity":"warn","title":"Slot","detail":"current pointer is missing","fix":format!("mangostudio-runtime install --slot {slot}")}));
        }
        Err(error) => {
            findings.push(json!({"severity":"fail","title":"Slot","detail":format!("current pointer is invalid: {error}"),"fix":format!("mangostudio-runtime install --slot {slot}")}));
        }
        Ok(None) => {}
    }
    findings
}

/// What `doctor` concludes from `service status` on a paired remote slot.
///
/// Usage: `service_findings(&Ok(status))`, with `status` the JSON
/// `service status --json` prints.
fn service_findings(status: &io::Result<Value>) -> Vec<Value> {
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            return vec![
                json!({"severity":"warn","title":"Service","detail":format!("could not read the user service: {error}")}),
            ];
        }
    };
    if status["error"].is_string() {
        return vec![json!({"severity":"warn","title":"Service","detail":status["error"]})];
    }
    if status["installed"] != true {
        return vec![
            json!({"severity":"warn","title":"Service","detail":"no user-level service keeps this runtime running across logout or reboot","fix":"mangostudio-runtime service install"}),
        ];
    }
    [
        ("enabled", "warn", "the user service is not enabled"),
        ("running", "fail", "the user service is not running"),
        (
            "execUsesCurrent",
            "warn",
            "the user service does not use the current pointer",
        ),
        (
            "currentBinaryPresent",
            "fail",
            "the current slot binary is missing",
        ),
    ]
    .into_iter()
    .filter(|(field, _, _)| status[*field] == false)
    .map(|(_, severity, detail)| {
        json!({"severity":severity,"title":"Service","detail":detail,"fix":"mangostudio-runtime service install"})
    })
    .collect()
}

pub(super) fn run_service(args: ServiceArgs, env: &impl EnvSource) -> i32 {
    let Some(home) = super::mango_home_or_report(env) else {
        return 1;
    };
    match user_service::run(args.action, args.mode, args.force, &home) {
        Ok(status) => {
            if args.json {
                println!("{status}");
            } else if args.action == super::ServiceAction::Status {
                println!(
                    "installed  {}\nenabled    {}\nrunning    {}",
                    status["installed"], status["enabled"], status["running"]
                );
            } else {
                println!(
                    "{} mangostudio-runtime service.",
                    match args.action {
                        super::ServiceAction::Install => "Installed",
                        super::ServiceAction::Uninstall => "Removed",
                        super::ServiceAction::Start => "Started",
                        super::ServiceAction::Stop => "Stopped",
                        super::ServiceAction::Restart => "Restart requested",
                        super::ServiceAction::Status => unreachable!(),
                    }
                );
            }
            0
        }
        Err(error) => report_error(args.json, &error.to_string()),
    }
}

fn parse_since(raw: &str) -> Result<DateTime<Utc>, String> {
    let raw = raw.trim();
    if let Some(unit) = raw.chars().last().map(|unit| unit.to_ascii_lowercase())
        && matches!(unit, 's' | 'm' | 'h' | 'd')
        && !raw[..raw.len() - 1].is_empty()
        && raw[..raw.len() - 1]
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        && let Ok(amount) = raw[..raw.len() - 1].parse::<i64>()
    {
        let seconds = amount
            .checked_mul(match unit {
                's' => 1,
                'm' => 60,
                'h' => 3600,
                _ => 86400,
            })
            .ok_or_else(|| format!("--since {raw:?} is outside the supported date range"))?;
        return Utc::now()
            .checked_sub_signed(chrono::Duration::seconds(seconds))
            .ok_or_else(|| format!("--since {raw:?} is outside the supported date range"));
    }
    DateTime::parse_from_rfc3339(raw)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|_| {
            format!("--since {raw:?} is not an ISO-8601 instant or relative duration like 24h")
        })
}

fn audit_records(
    path: &Path,
    since: Option<DateTime<Utc>>,
    denied: bool,
) -> io::Result<Vec<Value>> {
    let mut records = Vec::new();
    for index in (0..=20).rev() {
        let path = if index == 0 {
            path.to_path_buf()
        } else {
            PathBuf::from(format!("{}.{}", path.display(), index))
        };
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for line in io::BufReader::new(file).lines() {
            let line = line?;
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if !record["ts"].is_string()
                || !record["method"].is_string()
                || !record["hub"].is_string()
                || !record["durationMs"].is_number()
            {
                continue;
            }
            if !matches!(record["outcome"].as_str(), Some("ok" | "denied" | "error")) {
                continue;
            }
            if denied && record["outcome"] != "denied" {
                continue;
            }
            if let Some(since) = since
                && DateTime::parse_from_rfc3339(record["ts"].as_str().unwrap_or(""))
                    .is_ok_and(|time| time.with_timezone(&Utc) < since)
            {
                continue;
            }
            records.push(record);
        }
    }
    Ok(records)
}

pub(super) fn run_audit(args: AuditArgs, env: &impl EnvSource) -> i32 {
    let Some(home) = super::mango_home_or_report(env) else {
        return 1;
    };
    let slot = args
        .slot
        .unwrap_or_else(|| resolve_runtime_slot_for_current_exe(&home));
    let since = match args.since.as_deref().map(parse_since).transpose() {
        Ok(since) => since,
        Err(error) => return report_error(args.json, &error),
    };
    match audit_records(&slot_audit_log_path(slot, &home), since, args.denied) {
        Ok(records) => {
            if args.json {
                println!("{}", json!(records));
            } else if records.is_empty() {
                println!(
                    "No audit lines for the {slot} runtime{}.",
                    if args.denied { " (denied only)" } else { "" }
                );
            } else {
                for record in records {
                    println!(
                        "{} {} {} {} {}ms",
                        record["ts"].as_str().unwrap_or("?"),
                        record["outcome"].as_str().unwrap_or("?"),
                        record["method"].as_str().unwrap_or("?"),
                        record["hub"].as_str().unwrap_or("?"),
                        record["durationMs"]
                    );
                }
            }
            0
        }
        Err(error) => report_error(args.json, &error.to_string()),
    }
}

fn report_error(json_output: bool, message: &str) -> i32 {
    if json_output {
        println!("{}", json!({"error":message}));
    } else {
        eprintln!("mangostudio-runtime: {message}");
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::scratch_dir;

    #[cfg(unix)]
    #[test]
    fn self_install_publishes_and_reinstall_is_unchanged() {
        let home = scratch_dir("native-install");
        let source = home.join("downloaded-runtime");
        fs::write(&source, b"runtime bytes").unwrap();
        let first = install_source(&source, RuntimeSlot::Remote, "1.2.3", &home).unwrap();
        assert!(!first.unchanged);
        assert_eq!(
            fs::read(&first.current_binary_path).unwrap(),
            b"runtime bytes"
        );
        let second = install_source(&source, RuntimeSlot::Remote, "1.2.3", &home).unwrap();
        assert!(second.unchanged);

        fs::write(&first.binary_path, b"tampered bytes").unwrap();
        let error = install_source(&source, RuntimeSlot::Remote, "1.2.3", &home).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(
            error
                .to_string()
                .contains("already exists with different bytes")
        );
        assert_eq!(
            fs::read(&first.current_binary_path).unwrap(),
            b"tampered bytes"
        );
    }

    #[cfg(windows)]
    #[test]
    fn self_install_copies_source_into_an_immutable_windows_version() {
        let home = scratch_dir("native-install-windows");
        let source = home.join("downloaded-runtime.exe");
        fs::write(&source, b"runtime bytes").unwrap();
        let result = install_source(&source, RuntimeSlot::Remote, "1.2.3", &home).unwrap();
        assert_eq!(fs::read(&result.binary_path).unwrap(), b"runtime bytes");
        assert!(
            result
                .current_binary_path
                .ends_with("mangostudio-runtime.cmd")
        );
        assert!(slot_current_binary_path(RuntimeSlot::Remote, &home).is_file());
        assert_eq!(
            read_slot_current(&slot_dir(RuntimeSlot::Remote, &home))
                .unwrap()
                .as_deref(),
            Some("1.2.3")
        );
        assert_eq!(fs::read(&source).unwrap(), b"runtime bytes");
    }

    #[test]
    fn audit_filters_denials_and_ignores_malformed_lines() {
        let home = scratch_dir("native-audit");
        let path = home.join("audit.log");
        fs::write(&path, "bad\n{\"ts\":\"2026-09-20T00:00:00Z\",\"method\":\"shell.run\",\"hub\":\"hub\",\"outcome\":\"denied\",\"durationMs\":1}\n{\"ts\":\"2026-09-20T00:00:00Z\",\"method\":\"git.exec\",\"hub\":\"hub\",\"outcome\":\"ok\",\"durationMs\":1}\n").unwrap();
        assert_eq!(audit_records(&path, None, true).unwrap().len(), 1);
        let after = parse_since("2026-09-21T00:00:00Z").unwrap();
        assert!(audit_records(&path, Some(after), false).unwrap().is_empty());
        assert!(parse_since("impossible").is_err());
        assert!(parse_since("-1h").is_err());
        assert!(parse_since("24H").is_ok());
    }

    fn titled<'a>(findings: &'a [Value], title: &str) -> Vec<&'a Value> {
        findings
            .iter()
            .filter(|finding| finding["title"] == title)
            .collect()
    }

    fn health_report(version: Value) -> Value {
        json!({
            "slot": "remote",
            "version": version,
            "runtimeVersion": "2.0.0",
            "setup": {"state": "configured"},
            "audit": {"enabled": true},
            "lastError": null,
        })
    }

    #[test]
    fn doctor_warns_when_the_config_records_another_version_than_this_binary() {
        let findings = health_findings(&health_report(json!("1.9.0")), None);
        let version = titled(&findings, "Version");
        assert!(
            version.len() == 1
                && version[0]["severity"] == "warn"
                && version[0]["detail"]
                    .as_str()
                    .is_some_and(|detail| detail.contains("records 1.9.0 but this binary is 2.0.0")),
            "expected one Version warning naming both versions | received: {findings:?}"
        );
        for matching in [json!("2.0.0"), Value::Null] {
            let findings = health_findings(&health_report(matching.clone()), None);
            assert!(
                titled(&findings, "Version").is_empty(),
                "expected no Version finding for config version {matching} | received: {findings:?}"
            );
        }
    }

    #[test]
    fn doctor_surfaces_the_audit_sidecar_write_failure() {
        let home = scratch_dir("doctor-audit-error");
        assert!(
            read_audit_error(RuntimeSlot::Remote, &home).is_none(),
            "expected no audit error without a sidecar | received: one"
        );
        let mut sidecar = slot_audit_log_path(RuntimeSlot::Remote, &home).into_os_string();
        sidecar.push(".error");
        let sidecar = PathBuf::from(sidecar);
        fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        fs::write(
            &sidecar,
            "No space left on device (os error 28) (3 record(s) dropped)\n",
        )
        .unwrap();

        let error = read_audit_error(RuntimeSlot::Remote, &home);
        let findings = health_findings(&health_report(json!("2.0.0")), error.as_deref());
        let audit = titled(&findings, "Audit");
        assert!(
            audit.len() == 1
                && audit[0]["severity"] == "warn"
                && audit[0]["detail"]
                    == "the last audit write failed: No space left on device (os error 28) (3 record(s) dropped)",
            "expected one Audit warning quoting the sidecar | received: {findings:?}"
        );

        let mut disabled = health_report(json!("2.0.0"));
        disabled["audit"]["enabled"] = json!(false);
        let findings = health_findings(&disabled, error.as_deref());
        assert!(
            titled(&findings, "Audit").is_empty(),
            "expected no Audit finding for a stale sidecar while audit is off | received: {findings:?}"
        );
    }

    #[test]
    fn doctor_consent_pending_is_a_failure_with_a_setup_fix() {
        let mut report = health_report(json!("2.0.0"));
        report["setup"]["state"] = json!("pending");
        let findings = health_findings(&report, None);
        let consent = titled(&findings, "Consent");
        assert!(
            consent.len() == 1
                && consent[0]["severity"] == "fail"
                && consent[0]["fix"]
                    .as_str()
                    .is_some_and(|fix| fix.starts_with("mangostudio-runtime setup --slot remote")),
            "expected a failing Consent finding with a setup fix | received: {findings:?}"
        );
    }

    #[test]
    fn doctor_service_findings_follow_the_status_report() {
        let cases = [
            (
                Err(io::Error::other("systemctl vanished")),
                vec![(
                    "warn",
                    "could not read the user service: systemctl vanished",
                )],
            ),
            (
                Ok(json!({"installed": false, "error": "no session bus"})),
                vec![("warn", "no session bus")],
            ),
            (
                Ok(json!({"installed": false})),
                vec![(
                    "warn",
                    "no user-level service keeps this runtime running across logout or reboot",
                )],
            ),
            (
                Ok(
                    json!({"installed": true, "enabled": true, "running": true, "execUsesCurrent": true, "currentBinaryPresent": true}),
                ),
                vec![],
            ),
            (
                Ok(
                    json!({"installed": true, "enabled": false, "running": false, "execUsesCurrent": false, "currentBinaryPresent": false}),
                ),
                vec![
                    ("warn", "the user service is not enabled"),
                    ("fail", "the user service is not running"),
                    ("warn", "the user service does not use the current pointer"),
                    ("fail", "the current slot binary is missing"),
                ],
            ),
        ];
        for (status, expected) in cases {
            let findings = service_findings(&status);
            let received: Vec<(String, String)> = findings
                .iter()
                .map(|finding| {
                    (
                        finding["severity"].as_str().unwrap_or("?").to_owned(),
                        finding["detail"].as_str().unwrap_or("?").to_owned(),
                    )
                })
                .collect();
            let expected: Vec<(String, String)> = expected
                .into_iter()
                .map(|(severity, detail)| (severity.to_owned(), detail.to_owned()))
                .collect();
            assert!(
                received == expected,
                "status {status:?} expected findings: {expected:?} | received: {received:?}"
            );
        }
    }

    #[test]
    fn install_refuses_a_source_binary_already_inside_a_slot() {
        let home = scratch_dir("native-install-from-slot");
        let source = slot_version_binary_path(RuntimeSlot::Remote, "1.0.0", &home);
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"runtime bytes").unwrap();
        let error = install_source(&source, RuntimeSlot::Host, "1.2.3", &home)
            .expect_err("a binary inside a slot must not be installed again");
        assert!(
            error.kind() == io::ErrorKind::InvalidInput
                && error
                    .to_string()
                    .contains("already runs from a runtime slot"),
            "expected InvalidInput naming the slot source | received: {:?} {error}",
            error.kind()
        );
        assert!(
            read_slot_current(&slot_dir(RuntimeSlot::Host, &home))
                .unwrap()
                .is_none(),
            "expected no current pointer published | received: one"
        );
    }

    #[test]
    fn since_past_the_supported_date_range_is_refused_by_name() {
        let error = parse_since("999999999d").expect_err("two million years back is out of range");
        assert!(
            error == "--since \"999999999d\" is outside the supported date range",
            "expected the out-of-range message | received: {error}"
        );
    }
}
