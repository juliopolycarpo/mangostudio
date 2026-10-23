# Named CIM fake: every lookup is recorded and unexpected PIDs are errors.
function Invoke-FakeServiceTestCimQuery {
  param([uint32]$ProcessId)
  $script:ServiceTestFakeQueries += $ProcessId
  if ($script:ServiceTestFakeQueryError) { throw 'Fake CIM access denied' }
  if (-not $script:ServiceTestFakeRows.ContainsKey($ProcessId)) {
    throw "Fake CIM expected a configured PID | received: $ProcessId"
  }
  $script:ServiceTestFakeRows[$ProcessId]
}

function Assert-ServiceTestProbe {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-ServiceTestProbeFailure {
  param([scriptblock]$Action, [string]$Expected)
  $received = $null
  try { & $Action | Out-Null } catch { $received = $_.Exception.Message }
  if (($null -eq $received) -or -not $received.Contains($Expected)) {
    throw "expected failure containing '$Expected' | received: $received"
  }
}

# Exercises capture, lifetime matching and refusal cases with the named CIM fake.
# Usage: Invoke-ServiceTestIdentityProbe -Native also checks an owned real child.
function Invoke-ServiceTestIdentityProbe {
  param([switch]$Native)
  $ErrorActionPreference = 'Stop'
  $created = [datetime]'2026-10-23T00:00:00Z'
  $root = [pscustomobject]@{ ProcessId = [uint32]748; Name = 'cmd.exe'; CreationDate = $created }
  $leaf = [pscustomobject]@{ ProcessId = [uint32]756; Name = 'ping.exe'; CreationDate = $created.AddSeconds(1) }
  $otherLeaf = [pscustomobject]@{ ProcessId = [uint32]860; Name = 'ping.exe'; CreationDate = $created.AddSeconds(2) }
  $script:ServiceTestFakeRows = @{}
  $script:ServiceTestFakeQueryError = $false
  $passed = @()
  $nativeReceipt = $null
  foreach ($case in @('gone', 'original-alive', 'original-with-different-image', 'reused-pid', 'reused-pid-same-image', 'single-leaf', 'multiple-leaves')) {
    $script:ServiceTestFakeQueries = @()
    $rows = if ($case -eq 'multiple-leaves') { @($root, $leaf, $otherLeaf) } elseif ($case -eq 'single-leaf') { @($root, $leaf) } else { @($root) }
    $rows = @($rows)
    foreach ($row in $rows) { $script:ServiceTestFakeRows[$row.ProcessId] = @() }
    if ($case -eq 'original-alive') { $script:ServiceTestFakeRows[[uint32]748] = @($root) }
    if ($case -eq 'original-with-different-image') {
      $script:ServiceTestFakeRows[[uint32]748] = @([pscustomobject]@{
        ProcessId = [uint32]748; Name = 'renamed.exe'; CreationDate = $created
      })
    }
    if (($case -eq 'reused-pid') -or ($case -eq 'reused-pid-same-image')) {
      $image = if ($case -eq 'reused-pid') { 'unrelated.exe' } else { 'cmd.exe' }
      $script:ServiceTestFakeRows[[uint32]748] = @([pscustomobject]@{
        ProcessId = [uint32]748; Name = $image; CreationDate = $created.AddSeconds(30)
      })
    }
    if ($case -eq 'multiple-leaves') {
      $script:ServiceTestFakeRows[[uint32]756] = @($leaf)
      $script:ServiceTestFakeRows[[uint32]860] = @($otherLeaf)
    }
    $captured = @(Capture-ServiceTestIdentities $rows)
    $report = Get-ServiceTestReceipt $captured ${function:Invoke-FakeServiceTestCimQuery}
    $wanted = switch ($case) { 'original-alive' { 1 } 'original-with-different-image' { 1 } 'multiple-leaves' { 2 } default { 0 } }
    Assert-ServiceTestProbe ($report.survivors.Count -eq $wanted) "$case expected $wanted original-lifetime survivors | received: $($report.survivors | ConvertTo-Json -Compress)"
    Assert-ServiceTestProbe ($report.captured.Count -eq $rows.Count) "$case expected $($rows.Count) captured rows | received: $($report.captured.Count)"
    Assert-ServiceTestProbe (($script:ServiceTestFakeQueries -join ',') -eq (($rows | ForEach-Object { $_.ProcessId }) -join ',')) "$case expected every captured PID queried | received: $($script:ServiceTestFakeQueries -join ',')"
    $roundTrip = $report | ConvertTo-Json -Compress -Depth 5 | ConvertFrom-Json
    Assert-ServiceTestProbe ($roundTrip.captured.Count -eq $rows.Count) "$case expected every identity in JSON receipt | received: $($roundTrip.captured.Count)"
    if ($wanted -gt 0) {
      Assert-ServiceTestProbe ($roundTrip.survivors[0].image -match '\.exe$') "$case expected survivor image | received: $($roundTrip.survivors[0].image)"
      Assert-ServiceTestProbe ($roundTrip.survivors[0].creationTimeUtcTicks -match '^[1-9][0-9]+$') "$case expected UTC creation identity | received: $($roundTrip.survivors[0].creationTimeUtcTicks)"
    }
    $passed += $case
  }

  $captured = @(Capture-ServiceTestIdentities @($root))
  $script:ServiceTestFakeQueryError = $true
  Assert-ServiceTestProbeFailure { Get-ServiceTestReceipt $captured ${function:Invoke-FakeServiceTestCimQuery} } 'Fake CIM access denied'
  $script:ServiceTestFakeQueryError = $false
  $passed += 'query-error-is-not-gone'

  $script:ServiceTestFakeRows[[uint32]748] = @([pscustomobject]@{ ProcessId = [uint32]749; Name = 'wrong.exe'; CreationDate = $created })
  Assert-ServiceTestProbeFailure { Get-ServiceTestReceipt $captured ${function:Invoke-FakeServiceTestCimQuery} } 'expected queried PID 748 | received: 749'
  $passed += 'mismatched-query-pid'

  $script:ServiceTestFakeRows[[uint32]748] = @($root, $root)
  Assert-ServiceTestProbeFailure { Get-ServiceTestReceipt $captured ${function:Invoke-FakeServiceTestCimQuery} } 'expected at most one CIM row for PID 748 | received: 2'
  $passed += 'duplicate-query-rows'

  $script:ServiceTestFakeRows[[uint32]748] = @([pscustomobject]@{ ProcessId = [uint32]748; Name = 'cmd.exe'; CreationDate = $null })
  Assert-ServiceTestProbeFailure { Get-ServiceTestReceipt $captured ${function:Invoke-FakeServiceTestCimQuery} } 'expected CIM CreationDate DateTime for PID 748 image cmd.exe'
  $passed += 'unknown-query-identity'

  Assert-ServiceTestProbeFailure { Capture-ServiceTestIdentities @() } 'expected nonempty owned CIM process capture'
  Assert-ServiceTestProbeFailure { Capture-ServiceTestIdentities @($root, $root) } 'expected one captured lifetime per PID'
  Assert-ServiceTestProbeFailure { Capture-ServiceTestIdentities @([pscustomobject]@{ ProcessId = [uint32]0; Name = 'cmd.exe'; CreationDate = $created }) } 'expected positive CIM ProcessId'
  Assert-ServiceTestProbeFailure { Capture-ServiceTestIdentities @([pscustomobject]@{ ProcessId = [uint32]748; Name = ''; CreationDate = $created }) } 'expected CIM image name for PID 748'
  Assert-ServiceTestProbeFailure { Capture-ServiceTestIdentities @([pscustomobject]@{ ProcessId = [uint32]748; Name = 'cmd.exe'; CreationDate = $null }) } 'expected CIM CreationDate DateTime for PID 748'
  Assert-ServiceTestProbeFailure { Capture-ServiceTestIdentities @([pscustomobject]@{ ProcessId = [uint32]748; Name = 'cmd.exe'; CreationDate = [datetime]::SpecifyKind([datetime]::MinValue, [DateTimeKind]::Utc) }) } 'expected positive CIM creation ticks for PID 748'
  Assert-ServiceTestProbeFailure { Get-ServiceTestReceipt @() ${function:Invoke-FakeServiceTestCimQuery} } 'expected nonempty captured process lifetimes'
  $passed += 'invalid-capture'

  if ($Native) {
    $owned = Start-Process powershell.exe -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru
    try {
      $deadline = (Get-Date).AddSeconds(5)
      do {
        $live = @(Read-ServiceTestCimProcess $owned.Id)
        if ($live.Count -eq 1) { break }
        Start-Sleep -Milliseconds 100
      } while ((Get-Date) -lt $deadline)
      Assert-ServiceTestProbe ($live.Count -eq 1) "expected owned native PID $($owned.Id) captured | received: $($live.Count) CIM rows"
      $captured = @(Capture-ServiceTestIdentities $live)
      $before = Get-ServiceTestReceipt $captured
      Assert-ServiceTestProbe ($before.survivors.Count -eq 1) "expected owned native lifetime alive | received: $($before | ConvertTo-Json -Compress -Depth 5)"
      $owned.Kill()
      Assert-ServiceTestProbe ($owned.WaitForExit(5000)) "expected owned native PID $($owned.Id) stopped"
      $after = Get-ServiceTestReceipt $captured
      Assert-ServiceTestProbe ($after.survivors.Count -eq 0) "expected owned native lifetime gone | received: $($after | ConvertTo-Json -Compress -Depth 5)"
      $nativeReceipt = [pscustomobject]@{
        processId = $owned.Id
        before = $before
        after = $after
        exited = $owned.HasExited
        exitCode = $owned.ExitCode
        disposed = $false
      }
      $passed += 'native-owned-child'
    } finally {
      if (-not $owned.HasExited) { $owned.Kill(); $null = $owned.WaitForExit(5000) }
      $owned.Dispose()
      if ($null -ne $nativeReceipt) { $nativeReceipt.disposed = $true }
    }
  }
  [pscustomobject]@{ cases = @($passed); count = $passed.Count; native = [bool]$Native; nativeReceipt = $nativeReceipt }
}
