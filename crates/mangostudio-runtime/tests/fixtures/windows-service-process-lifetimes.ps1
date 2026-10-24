# Test-only identities: both observations use Win32_Process.CreationDate.
# Usage: $owned = @(Capture-ServiceTestIdentities @($root, $leaf));
#        Get-ServiceTestReceipt $owned | ConvertTo-Json -Compress -Depth 5

# Validates one CIM row and normalizes only its creation timestamp.
# Usage: ConvertTo-ServiceTestIdentity $cimRow
function ConvertTo-ServiceTestIdentity {
  param([AllowNull()][object]$Process)
  $id = $Process.ProcessId
  if ((($id -isnot [int]) -and ($id -isnot [uint32])) -or ($id -le 0)) {
    throw "expected positive CIM ProcessId | received: $id"
  }
  if (($Process.Name -isnot [string]) -or [string]::IsNullOrWhiteSpace($Process.Name)) {
    throw "expected CIM image name for PID $id | received: $($Process.Name)"
  }
  if ($Process.CreationDate -isnot [datetime]) {
    throw "expected CIM CreationDate DateTime for PID $id image $($Process.Name) | received: $($Process.CreationDate)"
  }
  $ticks = $Process.CreationDate.ToUniversalTime().Ticks
  if ($ticks -le 0) {
    throw "expected positive CIM creation ticks for PID $id image $($Process.Name) | received: $ticks"
  }
  [pscustomobject]@{
    processId = [uint32]$id
    image = $Process.Name
    creationTimeUtcTicks = $ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  }
}

# Preserves every captured root/leaf and refuses missing or duplicate identities.
# Usage: $captured = @(Capture-ServiceTestIdentities @($root, $leaf))
function Capture-ServiceTestIdentities {
  param([AllowNull()][AllowEmptyCollection()][object[]]$Processes)
  if (($null -eq $Processes) -or ($Processes.Count -eq 0)) {
    throw 'expected nonempty owned CIM process capture | received: no rows'
  }
  $seen = @{}
  foreach ($process in $Processes) {
    $identity = ConvertTo-ServiceTestIdentity $process
    if ($seen.ContainsKey($identity.processId)) {
      throw "expected one captured lifetime per PID | received duplicate: $($identity.processId) $($identity.image) $($identity.creationTimeUtcTicks)"
    }
    $seen[$identity.processId] = $true
    $identity
  }
}

# Queries the same CIM provider used for capture; native errors stay fatal.
# Usage: @(Read-ServiceTestCimProcess 748)
function Read-ServiceTestCimProcess {
  param([uint32]$ProcessId)
  Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
}

# Queries every captured PID and retains only its original creation identity.
# Usage: Get-ServiceTestReceipt $captured ${function:Invoke-FakeServiceTestCimQuery}
function Get-ServiceTestReceipt {
  param(
    [AllowNull()][AllowEmptyCollection()][object[]]$Captured,
    [scriptblock]$Query = ${function:Read-ServiceTestCimProcess}
  )
  $ErrorActionPreference = 'Stop'
  if (($null -eq $Captured) -or ($Captured.Count -eq 0)) {
    throw 'expected nonempty captured process lifetimes | received: no identities'
  }
  $queried = @()
  $survivors = @()
  foreach ($identity in $Captured) {
    try {
      $rows = @(& $Query $identity.processId)
    } catch {
      throw "expected CIM query for captured PID $($identity.processId) image $($identity.image) created $($identity.creationTimeUtcTicks) | received: $($_.Exception.Message)"
    }
    $queried += $identity.processId
    if ($rows.Count -gt 1) {
      throw "expected at most one CIM row for PID $($identity.processId) | received: $($rows.Count)"
    }
    if ($rows.Count -eq 0) { continue }
    $current = ConvertTo-ServiceTestIdentity $rows[0]
    if ($current.processId -ne $identity.processId) {
      throw "expected queried PID $($identity.processId) | received: $($current.processId) $($current.image) $($current.creationTimeUtcTicks)"
    }
    if ($current.creationTimeUtcTicks -eq $identity.creationTimeUtcTicks) {
      $survivors += $current
    }
  }
  [pscustomobject]@{
    captured = @($Captured)
    queriedProcessIds = @($queried)
    survivors = @($survivors)
  }
}
