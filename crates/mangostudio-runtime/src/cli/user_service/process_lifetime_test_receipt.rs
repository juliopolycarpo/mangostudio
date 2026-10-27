//! Strict, test-only receipts for the Windows service cleanup oracle.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
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

fn control_receipt(output: &str) -> Result<CleanupReceipt, String> {
    let receipt: CleanupReceipt = serde_json::from_str(output).map_err(|error| {
        format!("expected a complete process-lifetime receipt | received: {output:?}: {error}")
    })?;
    let capture_only = serde_json::json!({
        "captured": receipt.captured,
        "queriedProcessIds": receipt.queried_process_ids,
        "survivors": [],
    });
    ensure_stopped(&capture_only.to_string())?;
    Ok(receipt)
}

/// Requires the root, command and leaf alive, including every additional captured lifetime.
///
/// Usage: `ensure_live_control(&powershell_json, fixture.id()).expect("complete live control")`.
pub(super) fn ensure_live_control(output: &str, root_pid: u32) -> Result<(), String> {
    let receipt = control_receipt(output)?;
    let root_present = receipt
        .captured
        .iter()
        .any(|row| row.process_id == root_pid && row.image.eq_ignore_ascii_case("powershell.exe"));
    let command_present = receipt
        .captured
        .iter()
        .any(|row| row.image.eq_ignore_ascii_case("cmd.exe"));
    let leaf_present = receipt
        .captured
        .iter()
        .any(|row| row.image.eq_ignore_ascii_case("PING.EXE"));
    if !root_present || !command_present || !leaf_present {
        return Err(format!(
            "expected owned powershell.exe root PID {root_pid}, cmd.exe and PING.EXE | received: {:?}",
            receipt.captured
        ));
    }
    let captured: BTreeMap<_, _> = receipt
        .captured
        .iter()
        .map(|row| (row.process_id, row))
        .collect();
    let survivors: BTreeMap<_, _> = receipt
        .survivors
        .iter()
        .map(|row| (row.process_id, row))
        .collect();
    if survivors.len() != receipt.survivors.len() || survivors != captured {
        return Err(format!(
            "expected every captured lifetime alive exactly once: {:?} | received: {:?}",
            receipt.captured, receipt.survivors
        ));
    }
    Ok(())
}

/// Requires cleanup to query the unchanged complete capture and end all its lifetimes.
///
/// Usage: `ensure_capture_unchanged(&before_json, &after_json).expect("all captures settled")`.
pub(super) fn ensure_capture_unchanged(before: &str, after: &str) -> Result<(), String> {
    let before = control_receipt(before)?;
    ensure_stopped(after)?;
    let after = control_receipt(after)?;
    let original: BTreeMap<_, _> = before
        .captured
        .iter()
        .map(|row| (row.process_id, row))
        .collect();
    let current: BTreeMap<_, _> = after
        .captured
        .iter()
        .map(|row| (row.process_id, row))
        .collect();
    if original != current {
        return Err(format!(
            "expected unchanged captured lifetimes: {:?} | received: {:?}",
            before.captured, after.captured
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ensure_capture_unchanged, ensure_live_control, ensure_stopped};
    use serde_json::{Value, json};

    fn lifetime(id: u32, image: &str, ticks: &str) -> Value {
        json!({"processId": id, "image": image, "creationTimeUtcTicks": ticks})
    }

    fn receipt(captured: &[Value], queried: &[u32], survivors: &[Value]) -> String {
        json!({"captured": captured, "queriedProcessIds": queried, "survivors": survivors})
            .to_string()
    }

    fn live_control_rows() -> Vec<Value> {
        vec![
            lifetime(700, "powershell.exe", "99"),
            lifetime(748, "cmd.exe", "100"),
            lifetime(756, "PING.EXE", "101"),
        ]
    }

    fn row_ids(rows: &[Value]) -> Vec<u32> {
        rows.iter()
            .map(|row| row["processId"].as_u64().unwrap() as u32)
            .collect()
    }

    #[test]
    fn accepts_three_and_additional_live_control_members_without_omitting_any() {
        let mut rows = live_control_rows();
        for extra in [
            None,
            Some(lifetime(860, "conhost.exe", "102")),
            Some(lifetime(864, "extra.exe", "103")),
        ] {
            if let Some(extra) = extra {
                rows.push(extra);
            }
            let ids = row_ids(&rows);
            let live = receipt(&rows, &ids, &rows);
            ensure_live_control(&live, 700).unwrap();
            ensure_capture_unchanged(&live, &receipt(&rows, &ids, &[])).unwrap();
        }
    }

    #[test]
    fn rejects_missing_control_roles_and_wrong_root_identity() {
        let rows = live_control_rows();
        for missing in 0..rows.len() {
            let remaining: Vec<_> = rows
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != missing)
                .map(|(_, row)| row.clone())
                .collect();
            let error =
                ensure_live_control(&receipt(&remaining, &row_ids(&remaining), &remaining), 700)
                    .unwrap_err();
            assert!(
                error.contains("owned powershell.exe root PID 700, cmd.exe and PING.EXE"),
                "received: {error}"
            );
        }
        let error = ensure_live_control(&receipt(&rows, &row_ids(&rows), &rows), 701).unwrap_err();
        assert!(error.contains("root PID 701"), "received: {error}");
        let mut wrong_image = rows.clone();
        wrong_image[0]["image"] = json!("unrelated.exe");
        assert!(
            ensure_live_control(
                &receipt(&wrong_image, &row_ids(&wrong_image), &wrong_image),
                700
            )
            .unwrap_err()
            .contains("owned powershell.exe root")
        );
    }

    #[test]
    fn rejects_incomplete_duplicate_foreign_and_reused_live_control_evidence() {
        let rows = live_control_rows();
        let ids = row_ids(&rows);
        for queried in [
            vec![700, 748],
            vec![700, 748, 756, 756],
            vec![700, 748, 756, 900],
        ] {
            let error = ensure_live_control(&receipt(&rows, &queried, &rows), 700).unwrap_err();
            assert!(
                error.contains("every captured PID queried exactly once"),
                "received: {error}"
            );
        }
        let mut duplicate = rows.clone();
        duplicate.push(rows[1].clone());
        assert!(
            ensure_live_control(&receipt(&duplicate, &ids, &duplicate), 700)
                .unwrap_err()
                .contains("one captured lifetime per PID")
        );
        let mut cases = vec![rows[..2].to_vec(), duplicate];
        let mut foreign = rows.clone();
        foreign.push(lifetime(900, "foreign.exe", "120"));
        cases.push(foreign);
        let mut reused = rows.clone();
        reused[1]["creationTimeUtcTicks"] = json!("200");
        cases.push(reused);
        let mut renamed = rows.clone();
        renamed[1]["image"] = json!("other.exe");
        cases.push(renamed);
        for survivors in cases {
            let error = ensure_live_control(&receipt(&rows, &ids, &survivors), 700).unwrap_err();
            assert!(
                error.contains("every captured lifetime alive exactly once"),
                "received: {error}"
            );
        }
    }

    #[test]
    fn rejects_omitted_replaced_extra_and_surviving_post_fallback_members() {
        let mut rows = live_control_rows();
        rows.push(lifetime(860, "conhost.exe", "102"));
        let ids = row_ids(&rows);
        let before = receipt(&rows, &ids, &rows);
        let mut replaced = rows.clone();
        replaced[3]["creationTimeUtcTicks"] = json!("202");
        let mut extra = rows.clone();
        extra.push(lifetime(900, "extra.exe", "203"));
        for changed in [rows[..3].to_vec(), replaced, extra] {
            let error =
                ensure_capture_unchanged(&before, &receipt(&changed, &row_ids(&changed), &[]))
                    .unwrap_err();
            assert!(
                error.contains("unchanged captured lifetimes"),
                "received: {error}"
            );
        }
        let error =
            ensure_capture_unchanged(&before, &receipt(&rows, &ids, &rows[3..])).unwrap_err();
        assert!(
            error.contains("same-lifetime survivors") && error.contains("conhost.exe"),
            "received: {error}"
        );
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
