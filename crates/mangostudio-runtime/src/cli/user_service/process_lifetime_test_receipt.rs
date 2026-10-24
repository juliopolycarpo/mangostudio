//! Strict, test-only receipts for the Windows service cleanup oracle.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessLifetime {
    process_id: u32,
    image: String,
    creation_time_utc_ticks: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupReceipt {
    captured: Vec<ProcessLifetime>,
    queried_process_ids: Vec<u32>,
    survivors: Vec<ProcessLifetime>,
}

fn validate_identity(identity: &ProcessLifetime) -> Result<(), String> {
    let ticks = identity.creation_time_utc_ticks.parse::<u64>();
    if identity.process_id == 0
        || identity.image.trim().is_empty()
        || !ticks
            .is_ok_and(|value| value > 0 && value.to_string() == identity.creation_time_utc_ticks)
    {
        return Err(format!(
            "expected positive PID, image and canonical UTC creation ticks | received: {identity:?}"
        ));
    }
    Ok(())
}

/// Requires a complete query of every captured lifetime and no original survivors.
///
/// Usage: `ensure_stopped(&powershell_json).expect("owned process lifetimes stopped")`.
pub(super) fn ensure_stopped(output: &str) -> Result<(), String> {
    let receipt: CleanupReceipt = serde_json::from_str(output).map_err(|error| {
        format!("expected a complete process-lifetime receipt | received: {output:?}: {error}")
    })?;
    if receipt.captured.is_empty() {
        return Err("expected nonempty captured process lifetimes | received: []".to_owned());
    }
    let mut captured = BTreeMap::new();
    for identity in &receipt.captured {
        validate_identity(identity)?;
        if let Some(previous) = captured.insert(identity.process_id, identity) {
            return Err(format!(
                "expected one captured lifetime per PID | received: {previous:?}, {identity:?}"
            ));
        }
    }
    let queried: BTreeSet<_> = receipt.queried_process_ids.iter().copied().collect();
    let expected: BTreeSet<_> = captured.keys().copied().collect();
    if queried.len() != receipt.queried_process_ids.len() || queried != expected {
        return Err(format!(
            "expected every captured PID queried exactly once: {:?} | received: {:?}",
            captured.keys(),
            receipt.queried_process_ids
        ));
    }
    for survivor in &receipt.survivors {
        validate_identity(survivor)?;
        if !captured.get(&survivor.process_id).is_some_and(|original| {
            original.creation_time_utc_ticks == survivor.creation_time_utc_ticks
        }) {
            return Err(format!(
                "expected only captured process lifetimes in survivors | received: {survivor:?}"
            ));
        }
    }
    if !receipt.survivors.is_empty() {
        return Err(format!(
            "expected captured lifetimes stopped: {:?} | received same-lifetime survivors: {:?}",
            receipt.captured, receipt.survivors
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ensure_stopped;
    use serde_json::{Value, json};

    fn lifetime(id: u32, image: &str, ticks: &str) -> Value {
        json!({"processId": id, "image": image, "creationTimeUtcTicks": ticks})
    }

    fn receipt(captured: &[Value], queried: &[u32], survivors: &[Value]) -> String {
        json!({"captured": captured, "queriedProcessIds": queried, "survivors": survivors})
            .to_string()
    }

    #[test]
    fn accepts_complete_single_and_multiple_leaf_receipts() {
        for rows in [
            vec![
                lifetime(748, "cmd.exe", "100"),
                lifetime(756, "ping.exe", "101"),
            ],
            vec![
                lifetime(748, "cmd.exe", "100"),
                lifetime(756, "ping.exe", "101"),
                lifetime(860, "ping.exe", "102"),
            ],
        ] {
            let ids = rows
                .iter()
                .map(|row| row["processId"].as_u64().unwrap() as u32)
                .collect::<Vec<_>>();
            ensure_stopped(&receipt(&rows, &ids, &[])).unwrap();
        }
    }

    #[test]
    fn names_the_original_survivor_and_its_creation_identity() {
        let rows = [lifetime(756, "ping.exe", "638968608000000000")];
        for image in ["ping.exe", "renamed.exe"] {
            let survivor = [lifetime(756, image, "638968608000000000")];
            let error = ensure_stopped(&receipt(&rows, &[756], &survivor)).unwrap_err();
            let expected = [
                "same-lifetime survivors",
                "756",
                image,
                "638968608000000000",
            ];
            assert!(
                expected.iter().all(|value| error.contains(*value)),
                "expected {expected:?} | received: {error}"
            );
        }
    }

    #[test]
    fn rejects_a_reused_pid_reported_as_an_original_survivor() {
        let original = [lifetime(756, "ping.exe", "100")];
        for image in ["ping.exe", "unrelated.exe"] {
            let reused = [lifetime(756, image, "200")];
            let error = ensure_stopped(&receipt(&original, &[756], &reused)).unwrap_err();
            assert!(
                error.contains("only captured process lifetimes"),
                "received: {error}"
            );
            assert!(
                error.contains(image) && error.contains("200"),
                "received: {error}"
            );
        }
    }

    #[test]
    fn rejects_missing_duplicate_and_foreign_queries() {
        let rows = [
            lifetime(748, "cmd.exe", "100"),
            lifetime(756, "ping.exe", "101"),
        ];
        for ids in [vec![748], vec![748, 748, 756], vec![748, 756, 860]] {
            let error = ensure_stopped(&receipt(&rows, &ids, &[])).unwrap_err();
            assert!(
                error.contains("every captured PID queried exactly once"),
                "received: {error}"
            );
            assert!(error.contains(&format!("{ids:?}")), "received: {error}");
        }
    }

    #[test]
    fn rejects_invalid_missing_and_duplicate_capture_evidence() {
        for invalid in [
            lifetime(0, "cmd.exe", "100"),
            lifetime(748, "", "100"),
            lifetime(748, "cmd.exe", ""),
            lifetime(748, "cmd.exe", "unknown"),
            lifetime(748, "cmd.exe", "0100"),
        ] {
            let error = ensure_stopped(&receipt(&[invalid], &[748], &[])).unwrap_err();
            assert!(
                error.contains("positive PID, image and canonical UTC creation ticks"),
                "received: {error}"
            );
        }
        for (invalid, expected) in [
            ("{}".to_owned(), "missing field `captured`"),
            (
                "{\"queryError\":\"access denied\"}".to_owned(),
                "unknown field `queryError`",
            ),
            (
                receipt(&[], &[], &[]),
                "nonempty captured process lifetimes",
            ),
            (
                receipt(
                    &[
                        lifetime(748, "cmd.exe", "100"),
                        lifetime(748, "cmd.exe", "100"),
                    ],
                    &[748],
                    &[],
                ),
                "one captured lifetime per PID",
            ),
        ] {
            let error = ensure_stopped(&invalid).unwrap_err();
            assert!(
                error.contains(expected),
                "expected {expected:?} for {invalid} | received: {error}"
            );
        }
    }
}
