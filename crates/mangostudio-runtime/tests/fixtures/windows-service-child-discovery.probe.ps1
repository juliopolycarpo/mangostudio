# Named CIM child-query fake: synthetic PIDs are data, never native signal authority.
function Invoke-FakeServiceChildQuery {
  param([uint32]$ParentProcessId)
  $script:ServiceChildFakeQueries += $ParentProcessId
  if ($script:ServiceChildFakeError) { throw 'Named CIM child query access denied' }
  if (-not $script:ServiceChildFakeRows.ContainsKey($ParentProcessId)) {
    throw "Named child query expected configured parent PID | received: $ParentProcessId"
  }
  $script:ServiceChildFakeRows[$ParentProcessId]
}

# Proves parent-PID reuse cannot make stale rows ready or hide genuine descendant lifetimes.
# Usage: Invoke-ServiceChildDiscoveryProbe | ConvertTo-Json -Compress -Depth 5
function Invoke-ServiceChildDiscoveryProbe {
  $ErrorActionPreference = 'Stop'
  $created = [datetime]'2026-10-23T00:00:00Z'
  $root = [pscustomobject]@{ ProcessId = [uint32]100; Name = 'powershell.exe'; CreationDate = $created }
  $shell = [pscustomobject]@{ ProcessId = [uint32]200; ParentProcessId = [uint32]100; Name = 'cmd.exe'; CreationDate = $created.AddSeconds(1) }
  $oldShell = [pscustomobject]@{ ProcessId = [uint32]300; ParentProcessId = [uint32]100; Name = 'cmd.exe'; CreationDate = $created.AddSeconds(-10) }
  $oldLeaf = [pscustomobject]@{ ProcessId = [uint32]4700; ParentProcessId = [uint32]200; Name = 'vctip.exe'; CreationDate = $created.AddSeconds(-266) }
  $leaf = [pscustomobject]@{ ProcessId = [uint32]400; ParentProcessId = [uint32]200; Name = 'PING.EXE'; CreationDate = $created.AddSeconds(2) }
  $otherLeaf = [pscustomobject]@{ ProcessId = [uint32]500; ParentProcessId = [uint32]200; Name = 'other-owned.exe'; CreationDate = $created.AddSeconds(3) }
  $script:ServiceChildFakeRows = @{}
  $script:ServiceChildFakeQueries = @()
  $script:ServiceChildFakeError = $false
  $passed = @()

  $script:ServiceChildFakeRows[[uint32]200] = @($oldLeaf)
  $selected = @(Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery})
  Assert-ServiceTestProbe ($selected.Count -eq 0) "expected no eligible children before the owned leaf starts | received: $($selected.ProcessId -join ',')"
  Assert-ServiceTestProbe (($script:ServiceChildFakeQueries -join ',') -eq '200') "expected exactly the named parent query 200 | received: $($script:ServiceChildFakeQueries -join ',')"
  $passed += 'stale-parent-pid-is-not-ready'

  $script:ServiceChildFakeRows[[uint32]100] = @($oldShell, $shell)
  $shells = @(Find-ServiceTestChildren $root ${function:Invoke-FakeServiceChildQuery})
  Assert-ServiceTestProbe (($shells.ProcessId -join ',') -eq '200') "expected eligible shell PID 200 | received: $($shells.ProcessId -join ',')"
  $passed += 'shell-edge-excludes-older-lifetime'

  $script:ServiceChildFakeRows[[uint32]200] = @($oldLeaf, $leaf, $otherLeaf)
  $leaves = @(Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery})
  Assert-ServiceTestProbe (($leaves.ProcessId -join ',') -eq '400,500') "expected every eligible leaf PID 400,500 | received: $($leaves.ProcessId -join ',')"
  $captured = @(Capture-ServiceTestIdentities (@($root) + @($shells) + @($leaves)))
  Assert-ServiceTestProbe (($captured.processId -join ',') -eq '100,200,400,500') "expected only owned-generation captures 100,200,400,500 | received: $($captured.processId -join ',')"
  $passed += 'leaf-edge-keeps-all-eligible-images'

  $simultaneous = [pscustomobject]@{ ProcessId = [uint32]600; ParentProcessId = [uint32]200; Name = 'simultaneous.exe'; CreationDate = $shell.CreationDate }
  $script:ServiceChildFakeRows[[uint32]200] = @($simultaneous)
  $selected = @(Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery})
  Assert-ServiceTestProbe (($selected.ProcessId -join ',') -eq '600') "expected equal-creation child PID 600 retained | received: $($selected.ProcessId -join ',')"
  $passed += 'equal-creation-is-eligible'

  $script:ServiceChildFakeRows[[uint32]200] = @()
  $selected = @(Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery})
  Assert-ServiceTestProbe ($selected.Count -eq 0) "expected no rows from an empty snapshot | received: $($selected.Count)"
  $passed += 'empty-snapshot-is-not-ready'

  $script:ServiceChildFakeError = $true
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery} } 'expected CIM children of captured PID 200 created'
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery} } 'Named CIM child query access denied'
  $script:ServiceChildFakeError = $false
  $passed += 'query-error-is-not-empty'

  $beforeInvalidParent = $script:ServiceChildFakeQueries.Count
  $invalidParent = [pscustomobject]@{ ProcessId = [uint32]200; Name = 'cmd.exe'; CreationDate = $null }
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $invalidParent ${function:Invoke-FakeServiceChildQuery} } 'expected CIM CreationDate DateTime for PID 200'
  Assert-ServiceTestProbe ($script:ServiceChildFakeQueries.Count -eq $beforeInvalidParent) 'expected invalid parent refused before querying children'
  $passed += 'invalid-parent-fails-before-query'

  $script:ServiceChildFakeRows[[uint32]200] = @([pscustomobject]@{ ProcessId = [uint32]400; ParentProcessId = [uint32]200; Name = 'PING.EXE'; CreationDate = $null })
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery} } 'expected CIM CreationDate DateTime for PID 400'
  $passed += 'unknown-child-lifetime-is-not-ignored'

  $script:ServiceChildFakeRows[[uint32]200] = @([pscustomobject]@{ ProcessId = [uint32]400; ParentProcessId = [uint32]999; Name = 'PING.EXE'; CreationDate = $created })
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery} } 'expected ParentProcessId 200 for candidate PID 400 | received: 999'
  $passed += 'wrong-parent-query-row-fails'

  $script:ServiceChildFakeRows[[uint32]200] = @([pscustomobject]@{ ProcessId = [uint32]400; ParentProcessId = '200'; Name = 'PING.EXE'; CreationDate = $created })
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery} } 'expected CIM ParentProcessId Int32 or UInt32 for candidate PID 400 | received: System.String (200)'
  $passed += 'invalid-parent-reference-shape-fails'

  $script:ServiceChildFakeRows[[uint32]200] = @($leaf, $leaf)
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery} } 'expected one candidate lifetime per PID | received duplicate: 400'
  $passed += 'duplicate-query-rows-fail'

  $script:ServiceChildFakeRows[[uint32]200] = @([pscustomobject]@{ ProcessId = [uint32]200; ParentProcessId = [uint32]200; Name = 'cmd.exe'; CreationDate = $created })
  Assert-ServiceTestProbeFailure { Find-ServiceTestChildren $shell ${function:Invoke-FakeServiceChildQuery} } 'expected child PID distinct from parent 200 | received: 200'
  $passed += 'self-parent-query-row-fails'

  [pscustomobject]@{ cases = @($passed); count = $passed.Count; native = $false; capturedProcessIds = @($captured.processId); queriedParentProcessIds = @($script:ServiceChildFakeQueries) }
}
