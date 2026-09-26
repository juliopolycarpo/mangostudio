//! The PowerShell that drives the `MangoStudio Runtime` Scheduled Task's verbs.
//!
//! Pure text, compiled and tested on every platform so its logic stays
//! visible to Linux lint and test runs; only the Windows backend executes it.
//!
//! `Stop-ScheduledTask` ends the task's own process, the hidden
//! `powershell.exe` runner, and nothing else. The runner starts the slot's
//! `.cmd` shim, so `cmd.exe` and the runtime it launches outlive the stop and
//! keep the listen port: `stop` left the runtime serving, `restart`'s new run
//! could not bind and exited 1, and `uninstall` orphaned it. Every stopping
//! verb therefore finds the runner before stopping the task, waits for the
//! task to leave `Running`, then terminates whatever the runner started and
//! confirms it is gone before the same deadline, failing when it is not.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::Duration;

use super::super::super::ServiceAction;

/// The root Scheduled Task this runtime registers for the current user.
pub(super) const TASK: &str = "MangoStudio Runtime";

/// Quotes `text` as a PowerShell single-quoted literal.
///
/// Usage: `ps_quote("O'Brien")` is `'O''Brien'`.
pub(super) fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Records the task's live runner processes in `$runners` before the task is
/// stopped: `powershell.exe` processes whose command line carries the task
/// action's own arguments, which embed this home's encoded runner script.
///
/// `$runnersMissed` is set when the task was running but no runner matched,
/// so nothing identifies the runtime to end; [`verb_script`] then fails after
/// the stop instead of reporting a success it cannot check.
fn capture_runners(name: &str) -> String {
    format!(
        "$task = Get-ScheduledTask -TaskPath '\\' -TaskName {name} -ErrorAction SilentlyContinue\n\
         $runnerArguments = if ($null -eq $task) {{ '' }} else {{ [string]@($task.Actions)[0].Arguments }}\n\
         $runners = @(if ($runnerArguments) {{ Get-CimInstance Win32_Process -Filter \"Name = 'powershell.exe'\" | Where-Object {{ $_.CommandLine -and $_.CommandLine.Contains($runnerArguments) }} }})\n\
         $runnersMissed = ($null -ne $task) -and ([string]$task.State -eq 'Running') -and ($runners.Count -eq 0)"
    )
}

/// Terminates every process `$runners` started, directly or not, and fails
/// unless all of them, and any runner that survived the stop, have exited by
/// `$deadline`.
///
/// A child keeps its parent's id after the parent exits, so the tree is
/// walked from the recorded runners even once `Stop-ScheduledTask` has ended
/// them. Windows reuses process ids, so identity is the id plus its creation
/// time: a child created before its supposed parent, or after another
/// process took the parent's id, is not in the tree, and an id is terminated
/// only while the process holding it is still the one recorded. This
/// command's own ancestors are never terminated: a `service stop` issued from
/// inside the runtime it would stop reports that runtime as still running
/// instead of ending itself.
///
/// Usage: `format!("$deadline = ...\n{}\n{}", capture_runners(name), terminate_runner_tree())`.
pub(super) fn terminate_runner_tree() -> &'static str {
    "$processes = @(Get-CimInstance Win32_Process)\n\
     $byId = @{}\n\
     foreach ($process in $processes) { $byId[[uint32]$process.ProcessId] = $process }\n\
     $ancestors = @{}\n\
     $cursor = $byId[[uint32]$PID]\n\
     while (($null -ne $cursor) -and -not $ancestors.ContainsKey([uint32]$cursor.ProcessId)) { $ancestors[[uint32]$cursor.ProcessId] = $true; $cursor = $byId[[uint32]$cursor.ParentProcessId] }\n\
     $tree = @{}\n\
     $frontier = @($runners)\n\
     while ($frontier.Count -gt 0) {\n\
       $next = @()\n\
       foreach ($parent in $frontier) {\n\
         $holder = $byId[[uint32]$parent.ProcessId]\n\
         $reusedAt = if (($null -ne $holder) -and ($holder.CreationDate -ne $parent.CreationDate)) { $holder.CreationDate } else { $null }\n\
         foreach ($child in $processes) {\n\
           if (($child.ParentProcessId -eq $parent.ProcessId) -and ($child.CreationDate -ge $parent.CreationDate) -and (($null -eq $reusedAt) -or ($child.CreationDate -lt $reusedAt)) -and -not $tree.ContainsKey([uint32]$child.ProcessId)) { $tree[[uint32]$child.ProcessId] = $child; $next += $child }\n\
         }\n\
       }\n\
       $frontier = $next\n\
     }\n\
     foreach ($runner in $runners) { $tree[[uint32]$runner.ProcessId] = $runner }\n\
     foreach ($id in @($tree.Keys)) { $live = $byId[$id]; if (($null -ne $live) -and ($live.CreationDate -eq $tree[$id].CreationDate) -and -not $ancestors.ContainsKey($id)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }\n\
     do {\n\
       $alive = @($tree.Values | Where-Object { $live = Get-CimInstance Win32_Process -Filter \"ProcessId = $($_.ProcessId)\"; ($null -ne $live) -and ($live.CreationDate -eq $_.CreationDate) })\n\
       if (($alive.Count -eq 0) -or ((Get-Date) -ge $deadline)) { break }\n\
       Start-Sleep -Milliseconds 100\n\
     } while ($true)\n\
     if ($alive.Count -gt 0) { throw ('Scheduled Task runtime process(es) ' + (($alive | ForEach-Object { [string]$_.ProcessId + ' ' + $_.Name }) -join ', ') + ' still running after the task stopped') }"
}

/// Builds one Scheduled Task verb; every stop, its wait, and the runner tree's
/// termination end `wait` from launch.
///
/// Usage: `verb_script(ServiceAction::Restart, Duration::from_secs(27))`.
pub(super) fn verb_script(action: ServiceAction, wait: Duration) -> String {
    let name = ps_quote(TASK);
    let start = format!("Start-ScheduledTask -TaskPath '\\' -TaskName {name}");
    let wait_ms = wait.as_millis();
    // The deadline is taken first, before any manager call, so the stop wait,
    // the tree's termination and its survivor check all end `wait` after this
    // script starts: the caller's process timeout leaves only a fixed margin.
    let stop = format!(
        "$deadline = (Get-Date).AddMilliseconds({wait_ms})\n\
         {capture}\n\
         Stop-ScheduledTask -TaskPath '\\' -TaskName {name} -ErrorAction SilentlyContinue\n\
         while (((Get-ScheduledTask -TaskPath '\\' -TaskName {name}).State -eq 'Running') -and ((Get-Date) -lt $deadline)) {{ Start-Sleep -Milliseconds 200 }}\n\
         if ((Get-ScheduledTask -TaskPath '\\' -TaskName {name}).State -eq 'Running') {{ throw 'Scheduled Task still running after {wait_ms} ms' }}\n\
         {terminate}\n\
         if ($runnersMissed) {{ throw 'Scheduled Task was running but no runner process matched its action, so its runtime may still be running' }}",
        capture = capture_runners(&name),
        terminate = terminate_runner_tree(),
    );
    let body = match action {
        ServiceAction::Start => start,
        ServiceAction::Stop => stop,
        ServiceAction::Restart => format!("{stop}\n{start}"),
        ServiceAction::Uninstall => format!(
            "{stop}\nUnregister-ScheduledTask -TaskPath '\\' -TaskName {name} -Confirm:$false"
        ),
        ServiceAction::Install | ServiceAction::Status => {
            unreachable!(
                "{action:?} is not a Scheduled Task verb; expected start, stop, restart, or uninstall"
            )
        }
    };
    format!("$ErrorActionPreference = 'Stop'\n{body}")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{ServiceAction, verb_script};

    fn position(script: &str, needle: &str) -> usize {
        script
            .find(needle)
            .unwrap_or_else(|| panic!("expected {needle:?} in the verb | received:\n{script}"))
    }

    /// The regression: `Stop-ScheduledTask` alone reported success while the
    /// runner's `cmd.exe` and runtime kept serving. Each stopping verb has to
    /// find the runner first, stop, wait, then end the tree and check it.
    #[test]
    fn every_stopping_verb_terminates_the_runner_tree_after_the_task_stops() {
        for action in [
            ServiceAction::Stop,
            ServiceAction::Restart,
            ServiceAction::Uninstall,
        ] {
            let script = verb_script(action, Duration::from_millis(20_000));
            let deadline = position(&script, "$deadline = (Get-Date).AddMilliseconds(20000)");
            let capture = position(&script, "$runners = @(");
            let stop = position(&script, "Stop-ScheduledTask");
            let wait = position(
                &script,
                "while (((Get-ScheduledTask -TaskPath '\\' -TaskName 'MangoStudio Runtime').State",
            );
            let kill = position(&script, "Stop-Process -Id $id -Force");
            let survivors = position(&script, "still running after the task stopped");
            assert!(
                deadline < capture
                    && capture < stop
                    && stop < wait
                    && wait < kill
                    && kill < survivors,
                "expected {action:?} order: deadline < capture < stop < wait < kill < survivor \
                 check | received positions {deadline}, {capture}, {stop}, {wait}, {kill}, \
                 {survivors}"
            );
        }
    }

    /// A running task whose runner the capture cannot find must fail the verb
    /// after the stop, not report success with the runtime possibly alive.
    #[test]
    fn a_running_task_with_no_matching_runner_fails_the_verb() {
        for action in [
            ServiceAction::Stop,
            ServiceAction::Restart,
            ServiceAction::Uninstall,
        ] {
            let script = verb_script(action, Duration::from_secs(5));
            let missed = position(
                &script,
                "$runnersMissed = ($null -ne $task) -and ([string]$task.State -eq 'Running') -and ($runners.Count -eq 0)",
            );
            let stop = position(&script, "Stop-ScheduledTask");
            let refusal = position(&script, "if ($runnersMissed) { throw");
            let after = ["Start-ScheduledTask", "Unregister-ScheduledTask"]
                .iter()
                .filter_map(|verb| script.find(verb))
                .min()
                .unwrap_or(script.len());
            assert!(
                missed < stop && stop < refusal && refusal < after,
                "expected {action:?} order: record miss < stop < refuse < start/unregister | \
                 received positions {missed}, {stop}, {refusal}, {after}"
            );
        }
    }

    #[test]
    fn restart_starts_and_uninstall_unregisters_only_after_the_tree_is_gone() {
        let restart = verb_script(ServiceAction::Restart, Duration::from_secs(5));
        assert!(
            position(&restart, "still running after the task stopped")
                < position(&restart, "Start-ScheduledTask"),
            "expected restart to start the task after the old tree is gone | received:\n{restart}"
        );
        let uninstall = verb_script(ServiceAction::Uninstall, Duration::from_secs(5));
        assert!(
            position(&uninstall, "still running after the task stopped")
                < position(&uninstall, "Unregister-ScheduledTask"),
            "expected uninstall to unregister after the old tree is gone | received:\n{uninstall}"
        );
    }

    #[test]
    fn start_neither_stops_nor_terminates_anything() {
        let start = verb_script(ServiceAction::Start, Duration::ZERO);
        assert!(start.contains("Start-ScheduledTask"));
        for needle in ["Stop-ScheduledTask", "Stop-Process"] {
            assert!(
                !start.contains(needle),
                "expected start without {needle:?} | received:\n{start}"
            );
        }
    }

    /// The walk must skip this command's own ancestors and never follow or kill a reused id.
    #[test]
    fn the_tree_walk_spares_this_commands_ancestors_and_reused_ids() {
        let terminate = super::terminate_runner_tree();
        for guard in [
            "-not $ancestors.ContainsKey($id)",
            "$child.CreationDate -ge $parent.CreationDate",
            "$child.CreationDate -lt $reusedAt",
            "$live.CreationDate -eq $tree[$id].CreationDate",
            "$live.CreationDate -eq $_.CreationDate",
        ] {
            assert!(
                terminate.contains(guard),
                "expected the tree walk to guard with {guard:?} | received:\n{terminate}"
            );
        }
    }
}
