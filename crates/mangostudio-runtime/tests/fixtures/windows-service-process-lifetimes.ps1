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

# Queries candidate children; caller validates their lifetime relationship before capture.
# Usage: @(Read-ServiceTestCimChildren 748)
function Read-ServiceTestCimChildren {
  param([uint32]$ParentProcessId)
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentProcessId" -ErrorAction Stop
}

# Retains every valid child born within this captured parent's lifetime, regardless of image.
# Usage: $children = @(Find-ServiceTestChildren $root ${function:Invoke-FakeServiceChildQuery})
function Find-ServiceTestChildren {
  param(
    [AllowNull()][object]$Parent,
    [scriptblock]$Query = ${function:Read-ServiceTestCimChildren}
  )
  $ErrorActionPreference = 'Stop'
  $parentIdentity = ConvertTo-ServiceTestIdentity $Parent
  try {
    $rows = @(& $Query $parentIdentity.processId)
  } catch {
    throw "expected CIM children of captured PID $($parentIdentity.processId) created $($parentIdentity.creationTimeUtcTicks) | received: $($_.Exception.Message)"
  }
  $seen = @{}
  foreach ($row in $rows) {
    $identity = ConvertTo-ServiceTestIdentity $row
    $parentId = $row.ParentProcessId
    if (($parentId -isnot [int]) -and ($parentId -isnot [uint32])) {
      $shape = if ($null -eq $parentId) { 'null' } else { $parentId.GetType().FullName }
      throw "expected CIM ParentProcessId Int32 or UInt32 for candidate PID $($identity.processId) | received: $shape ($parentId)"
    }
    if ($parentId -ne $parentIdentity.processId) {
      throw "expected ParentProcessId $($parentIdentity.processId) for candidate PID $($identity.processId) | received: $parentId"
    }
    if ($identity.processId -eq $parentIdentity.processId) {
      throw "expected child PID distinct from parent $($parentIdentity.processId) | received: $($identity.processId)"
    }
    if ($seen.ContainsKey($identity.processId)) {
      throw "expected one candidate lifetime per PID | received duplicate: $($identity.processId)"
    }
    $seen[$identity.processId] = $true
    if ([long]$identity.creationTimeUtcTicks -lt [long]$parentIdentity.creationTimeUtcTicks) { continue }
    $row
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
