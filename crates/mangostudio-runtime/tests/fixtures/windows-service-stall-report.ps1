# Reports for a fixture that ran out of time or left a process behind (#2737). Kept apart from
# windows-service-process-lifetimes.ps1: that file is inlined into -EncodedCommand scripts that
# already sit near Windows' 32,767-character argv limit, so these are dot-sourced from a file.
# Usage: . $stallReportPath

# Describes a polling loop that ran out of time, so a stalled fixture reports its own state:
# how long it waited, how many polls ran and how slow the slowest was, the CPU load, and every
# process that could have been the one it waited for. A fixed sentence cannot tell a host that
# answered each CIM query in 20 s from a child that never started.
# Usage: throw (Format-ServiceTestStall 'expected X' 20012 3 9800 87 @($rows))
function Format-ServiceTestStall {
  param(
    [string]$Expected,
    [long]$ElapsedMs,
    [int]$Polls,
    [long]$SlowestPollMs,
    [AllowNull()][object]$CpuLoadPercent,
    [AllowNull()][AllowEmptyCollection()][object[]]$Processes
  )
  $listed = if (($null -eq $Processes) -or ($Processes.Count -eq 0)) { 'none' } else { (@($Processes | ForEach-Object { "$($_.ProcessId)<-$($_.ParentProcessId) $($_.Name)" }) -join ', ') }
  $load = if ($null -eq $CpuLoadPercent) { 'unknown' } else { "$CpuLoadPercent%" }
  "$Expected | received: not ready after $ElapsedMs ms, $Polls polls (slowest $SlowestPollMs ms), cpu load $load, processes: $listed"
}

# Reads what a stalled poll can still see: the runner, its children and any cmd.exe or PING.EXE,
# plus the CPU load. Called once, after the deadline, so it costs the passing case nothing.
# Usage: $sample = Get-ServiceTestStallSample 4242
function Get-ServiceTestStallSample {
  param([uint32]$RunnerProcessId)
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($_.ProcessId -eq $RunnerProcessId) -or ($_.ParentProcessId -eq $RunnerProcessId) -or ($_.Name -in @('cmd.exe', 'PING.EXE')) })
  $load = (Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average
  [pscustomobject]@{ Processes = $processes; CpuLoadPercent = $load }
}

# Reports each process a failed cleanup left running: whether the OS says it exited, its handle
# count, and what a second Stop-Process says with its error kept. terminate_runner_tree discards
# Stop-Process errors, so a refused kill and a process that lingers after a kill look alike.
# Usage: $survivors = Get-ServiceTestSurvivorReport @($alive)
function Get-ServiceTestSurvivorReport {
  param([AllowNull()][AllowEmptyCollection()][object[]]$Alive)
  $lines = @(@($Alive) | Where-Object { $null -ne $_ } | ForEach-Object {
    $row = $_
    $survivor = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    # Read before the retry: the retry may end the process.
    $exited = $survivor.HasExited
    $handles = $survivor.HandleCount
    $retry = try { Stop-Process -Id $row.ProcessId -Force -ErrorAction Stop; 'stop accepted' } catch { $_.Exception.Message }
    "$($row.ProcessId) $($row.Name) exited=$exited handles=$handles retry=$retry"
  })
  if ($lines.Count -eq 0) { 'none' } else { $lines -join '; ' }
}
