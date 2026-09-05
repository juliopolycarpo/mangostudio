#!/usr/bin/env pwsh
# Canonical MangoStudio installer for Windows. Published as a release asset on
# both channels and hosted at
# https://github.com/juliopolycarpo/mangostudio/releases/latest/download/install.ps1.
# The hub binary also embeds this file verbatim (see
# apps/api/src/modules/updates/infrastructure/embedded-installers.ts) and runs
# it locally for -Use, -Prune, and -Uninstall.
#
# This script is the only thing that writes the install layout under
# MANGOSTUDIO_INSTALL_DIR. Forward-compatibility rule: an older binary's
# embedded copy of this script may install a release newer than itself, so a
# script must never delete or rewrite anything it does not recognise in the
# root — unknown files stay untouched, and rewriting install-origin.json
# carries over every property this build does not know, unchanged.
param(
  [string]$Version,
  [switch]$Canary,
  [string]$Local,
  [string]$Use,
  [switch]$Rollback,
  [switch]$Prune,
  [switch]$Uninstall,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 does not auto-load System.Net.Http, which is used for
# resolving the latest GitHub Release redirect below. PowerShell 7 already has
# it loaded; this is a harmless no-op there.
Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'juliopolycarpo/mangostudio'
$GitHubBase = "https://github.com/$Repo"
$GitHubApi = "https://api.github.com/repos/$Repo"

# Keys install-origin.json may carry. Anything else found on disk is an
# unknown property and is carried over verbatim by Save-OriginRecord/Save-PruneRecord.
$OriginKnownKeys = @(
  'origin', 'channel', 'version', 'previousVersion', 'sourceSha',
  'installedAt', 'source', 'binDir', 'prunePending'
)

function Show-Usage {
  Write-Host 'Usage: install.ps1 [flags]'
  Write-Host ''
  Write-Host 'Installs MangoStudio into %LOCALAPPDATA%\mangostudio\<version>\.'
  Write-Host 'Creates %LOCALAPPDATA%\mangostudio\bin\mangostudio.cmd and adds that bin'
  Write-Host 'directory to the user PATH.'
  Write-Host ''
  Write-Host 'Flags:'
  Write-Host '  -Version <x.y.z>  Install a specific stable version'
  Write-Host '  -Canary           Install the rolling canary pre-release'
  Write-Host '  -Local <archive>  Install from a local archive (.zip release archive or .tgz npm tarball)'
  Write-Host '  -Use <version>    Point at an already installed version without downloading'
  Write-Host '  -Rollback         Point at the version that was current before the last switch'
  Write-Host '  -Prune            Remove installed versions other than current and previous'
  Write-Host '  -Uninstall        Remove the install root, the .cmd shim, and the user PATH entry'
  Write-Host '  -Help             Show this help message'
  Write-Host ''
  Write-Host 'Environment:'
  Write-Host '  MANGOSTUDIO_VERSION         Install a specific version instead of latest (-Version wins)'
  Write-Host '  MANGOSTUDIO_INSTALL_DIR     Override the versioned install root'
  Write-Host '  MANGOSTUDIO_BIN_DIR         Override the user bin directory'
  Write-Host '  MANGOSTUDIO_INSTALL_ORIGIN  Set to "upgrade" when the hub itself runs this script'
}

function Fail([string]$Message) {
  throw $Message
}

function Normalize-Version([string]$Version) {
  $normalized = $Version.Trim() -replace '^v', ''
  if ($normalized.Length -eq 0) { Fail 'version is empty' }
  return $normalized
}

function Get-Platform {
  $arch = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  } else {
    $env:PROCESSOR_ARCHITECTURE
  }

  if ($arch -in @('AMD64', 'x86_64')) { return 'windows-x64' }
  if ($arch -eq 'ARM64') { return 'windows-arm64' }
  Fail "unsupported architecture: $arch"
}

function Resolve-LatestVersion {
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)

  try {
    $response = $client.GetAsync("$GitHubBase/releases/latest").GetAwaiter().GetResult()
    $location = $response.Headers.Location
    if ($null -eq $location) { Fail 'latest release redirect did not include a Location header' }
    return Normalize-Version (($location.ToString() -split '/')[-1])
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Get-VersionFromLocalArchive([string]$Archive, [string]$Platform) {
  $name = [System.IO.Path]::GetFileName($Archive)
  $pattern = "^mangostudio-(.+)-$([regex]::Escape($Platform))\.zip$"
  $match = [regex]::Match($name, $pattern)
  if (-not $match.Success) { Fail "local archive does not match ${Platform}: $name" }
  return Normalize-Version $match.Groups[1].Value
}

function Save-Url([string]$Url, [string]$Path) {
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
}

function Find-Checksum([string]$ManifestPath, [string]$AssetName) {
  foreach ($line in Get-Content $ManifestPath) {
    # Keep in lockstep with archive-assets.ts, verify-checksum.ts, cargo-shim,
    # and install.sh; see scripts/tests/support/SHA256SUMS.sample.
    if ($line -match '^([a-fA-F0-9]{64})\s+\*?(.+)$' -and $Matches[2] -eq $AssetName) {
      return $Matches[1].ToLowerInvariant()
    }
  }

  Fail "SHA256SUMS does not contain $AssetName"
}

function Test-Checksum([string]$ManifestPath, [string]$ArchivePath, [string]$AssetName) {
  $expected = Find-Checksum $ManifestPath $AssetName
  $actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { Fail "checksum mismatch for $AssetName" }
  Write-Host "Checksum verified: $AssetName"
}

# --- Canary tag/manifest parsing -------------------------------------------
# Pure data-in, data-out so tests exercise them without a network call.

# $Releases: the parsed array Invoke-RestMethod returns for the releases API.
function Select-CanaryTag($Releases) {
  $match = $Releases | Where-Object { $_.tag_name -match '^v[0-9].*-canary$' } | Select-Object -First 1
  if ($match) { return $match.tag_name }
  return $null
}

function Get-CanaryTag {
  $releases = Invoke-RestMethod -Uri "$GitHubApi/releases?per_page=30" -UseBasicParsing
  $tag = Select-CanaryTag $releases
  if (-not $tag) { Fail 'no canary release found' }
  return $tag
}

# A property that may be absent from a JSON object. Set-StrictMode -Version
# Latest throws on direct dot access to a property that is not there, so every
# read of an optional install-origin.json / canary-manifest.json field goes
# through this instead.
function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object.PSObject.Properties.Name -contains $Name) { return $Object.$Name }
  return $null
}

function Get-ManifestField([string]$ManifestPath, [string]$Key) {
  $manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
  return Get-Prop $manifest $Key
}

# --- install-origin.json -----------------------------------------------
# PowerShell has a real JSON parser, unlike install.sh, so reading and
# rewriting it is a ConvertFrom-Json / ConvertTo-Json round trip that keeps
# every property the object already had. See the format contract in
# apps/api/src/modules/updates/domain/install-origin.ts.

function Read-OriginRecord([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try {
    return Get-Content -Raw $Path | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-VersionChannel([string]$Version) {
  if ($Version -match '-canary') { return 'canary' }
  return 'stable'
}

# Build the record to write: known fields in the documented order (empty ones
# omitted), then whatever property on $Carry this build does not recognise,
# unchanged.
function New-OriginRecord {
  param(
    [string]$Origin,
    [string]$Channel,
    [string]$RecordVersion,
    [string]$PreviousVersion,
    [string]$SourceSha,
    [string]$InstalledAt,
    [string]$Source,
    [string]$BinDir,
    [string[]]$PrunePending,
    $Carry
  )

  $ordered = [ordered]@{
    origin  = $Origin
    channel = $Channel
    version = $RecordVersion
  }
  if (-not [string]::IsNullOrEmpty($PreviousVersion)) { $ordered['previousVersion'] = $PreviousVersion }
  if (-not [string]::IsNullOrEmpty($SourceSha)) { $ordered['sourceSha'] = $SourceSha }
  if (-not [string]::IsNullOrEmpty($InstalledAt)) { $ordered['installedAt'] = $InstalledAt }
  if (-not [string]::IsNullOrEmpty($Source)) { $ordered['source'] = $Source }
  if (-not [string]::IsNullOrEmpty($BinDir)) { $ordered['binDir'] = $BinDir }
  if ($PrunePending -and $PrunePending.Count -gt 0) { $ordered['prunePending'] = @($PrunePending) }

  if ($null -ne $Carry) {
    foreach ($prop in $Carry.PSObject.Properties) {
      if ($OriginKnownKeys -notcontains $prop.Name) {
        $ordered[$prop.Name] = $prop.Value
      }
    }
  }

  return [PSCustomObject]$ordered
}

function Write-OriginRecord([string]$Path, $Record) {
  $json = $Record | ConvertTo-Json -Depth 6
  $tmp = "$Path.tmp.$PID"
  # Explicit no-BOM UTF8: Set-Content -Encoding UTF8 writes a BOM on Windows
  # PowerShell 5.1, and a leading BOM makes JSON.parse throw on the read side.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, "$json`r`n", $utf8NoBom)
  Move-Item -Path $tmp -Destination $Path -Force
}

# Record a pointer swap (fresh install, -Use, -Rollback). SourceKind empty
# carries over the previous record's source (a pointer-only republish did not
# download anything new); SourceSha empty drops the field.
function Save-OriginRecord {
  param(
    [string]$InstallRoot,
    [string]$OriginKind,
    [string]$NewVersion,
    [string]$OldVersion,
    [string]$SourceKind,
    [string]$SourceSha,
    [string]$BinDir
  )

  $originFile = Join-Path $InstallRoot 'install-origin.json'
  $existing = Read-OriginRecord $originFile
  $oldSource = Get-Prop $existing 'source'
  $prunePending = Get-Prop $existing 'prunePending'

  # A repair install, a retried upgrade, or -Use <current> reports
  # NewVersion -eq OldVersion: the pointer never actually moved. Keep the
  # rollback anchor pointing at whatever it already recorded instead of
  # collapsing previousVersion onto the version that is not changing.
  $previousVersion = if ($NewVersion -eq $OldVersion) { Get-Prop $existing 'previousVersion' } else { $OldVersion }

  $sourceVal = if ($SourceKind) { $SourceKind } else { $oldSource }
  $channel = Get-VersionChannel $NewVersion
  $installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

  $record = New-OriginRecord -Origin $OriginKind -Channel $channel -RecordVersion $NewVersion `
    -PreviousVersion $previousVersion -SourceSha $SourceSha -InstalledAt $installedAt `
    -Source $sourceVal -BinDir $BinDir -PrunePending $prunePending -Carry $existing

  Write-OriginRecord $originFile $record
}

# Record a prune: only prunePending changes, everything else carries over
# unchanged — a prune neither installs nor moves the pointer.
function Save-PruneRecord([string]$InstallRoot, [string[]]$Remaining) {
  $originFile = Join-Path $InstallRoot 'install-origin.json'
  $existing = Read-OriginRecord $originFile
  if ($null -eq $existing) { return }

  $record = New-OriginRecord -Origin (Get-Prop $existing 'origin') -Channel (Get-Prop $existing 'channel') `
    -RecordVersion (Get-Prop $existing 'version') -PreviousVersion (Get-Prop $existing 'previousVersion') `
    -SourceSha (Get-Prop $existing 'sourceSha') -InstalledAt (Get-Prop $existing 'installedAt') `
    -Source (Get-Prop $existing 'source') -BinDir (Get-Prop $existing 'binDir') `
    -PrunePending $Remaining -Carry $existing

  Write-OriginRecord $originFile $record
}

# --- Install layout ----------------------------------------------------

function Get-InstallRoot {
  $override = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_INSTALL_DIR')
  if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }

  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    Fail 'LocalApplicationData is unavailable; set MANGOSTUDIO_INSTALL_DIR.'
  }

  return Join-Path $localAppData 'mangostudio'
}

function Get-BinDir([string]$InstallRoot) {
  $override = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_BIN_DIR')
  if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
  return Join-Path $InstallRoot 'bin'
}

function Get-BinCmdPath([string]$BinDir) {
  return Join-Path $BinDir 'mangostudio.cmd'
}

function Split-PathList([AllowNull()][string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
  return @($Value -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Normalize-PathEntry([string]$Value) {
  try {
    return [System.IO.Path]::GetFullPath($Value).TrimEnd('\')
  } catch {
    return $Value.Trim().TrimEnd('\')
  }
}

function Test-PathListContains([string[]]$Entries, [string]$Candidate) {
  $normalizedCandidate = Normalize-PathEntry $Candidate
  foreach ($entry in $Entries) {
    $normalizedEntry = Normalize-PathEntry $entry
    if ([StringComparer]::OrdinalIgnoreCase.Equals($normalizedEntry, $normalizedCandidate)) {
      return $true
    }
  }
  return $false
}

function Add-UserPath([string]$BinDir) {
  $target = [System.EnvironmentVariableTarget]::User
  $userPath = [Environment]::GetEnvironmentVariable('Path', $target)
  $userParts = Split-PathList $userPath
  $changed = $false

  if (-not (Test-PathListContains $userParts $BinDir)) {
    [Environment]::SetEnvironmentVariable('Path', (($userParts + $BinDir) -join ';'), $target)
    $changed = $true
  }

  $processParts = Split-PathList $env:Path
  if (-not (Test-PathListContains $processParts $BinDir)) {
    $env:Path = (($processParts + $BinDir) -join ';')
  }

  return $changed
}

function Remove-UserPath([string]$BinDir) {
  $target = [System.EnvironmentVariableTarget]::User
  $userPath = [Environment]::GetEnvironmentVariable('Path', $target)
  $userParts = Split-PathList $userPath
  $normalizedTarget = Normalize-PathEntry $BinDir
  $filtered = @($userParts | Where-Object {
      -not [StringComparer]::OrdinalIgnoreCase.Equals((Normalize-PathEntry $_), $normalizedTarget)
    })

  if ($filtered.Count -eq $userParts.Count) { return $false }
  [Environment]::SetEnvironmentVariable('Path', ($filtered -join ';'), $target)
  return $true
}

# The .cmd shim's own quoted path is the single source of truth for "what
# version is current" — it is identical in shape whether this build wrote it
# or a pre-`current` install did, so it doubles as legacy detection.
function Get-CurrentVersionFromCmd([string]$InstallRoot, [string]$CmdPath) {
  if (-not (Test-Path $CmdPath)) { return $null }
  $content = Get-Content -Raw -ErrorAction SilentlyContinue $CmdPath
  if ([string]::IsNullOrEmpty($content)) { return $null }

  $match = [regex]::Match($content, '"([^"]+)\\mangostudio\.exe"\s+%\*')
  if (-not $match.Success) { return $null }

  $versionDir = $match.Groups[1].Value
  $versionDirParent = Normalize-PathEntry (Split-Path $versionDir -Parent)
  $rootFull = Normalize-PathEntry $InstallRoot
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($versionDirParent, $rootFull)) { return $null }

  return Split-Path $versionDir -Leaf
}

function Resolve-CurrentVersion([string]$InstallRoot, [string]$CmdPath) {
  $fromCmd = Get-CurrentVersionFromCmd $InstallRoot $CmdPath
  if ($fromCmd) { return $fromCmd }

  $originFile = Join-Path $InstallRoot 'install-origin.json'
  $existing = Read-OriginRecord $originFile
  $fromOrigin = Get-Prop $existing 'version'
  if ($fromOrigin) { return $fromOrigin }

  return $null
}

# Never Remove-Item -Recurse a junction: PowerShell 5.1 follows the reparse
# point and deletes the *target's* contents instead of just the link.
function Remove-Junction([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  try {
    [System.IO.Directory]::Delete($Path)
  } catch {
    cmd /c rmdir "$Path" | Out-Null
  }
}

# Courtesy only: a human or another tool browsing the install root can follow
# "current" without knowing the version. Nothing in this script reads it back
# — Get-CurrentVersionFromCmd is the real pointer — so a failure here is a
# warning, not a fatal error.
function Set-CurrentJunction([string]$InstallRoot, [string]$Version) {
  $junctionPath = Join-Path $InstallRoot 'current'
  try {
    Remove-Junction $junctionPath
    New-Item -ItemType Junction -Path $junctionPath -Target (Join-Path $InstallRoot $Version) -ErrorAction Stop | Out-Null
  } catch {
    Write-Host "Could not create ${junctionPath}: $($_.Exception.Message)"
  }
}

function Write-Shim([string]$InstallRoot, [string]$Version, [string]$BinDir) {
  $exePath = Join-Path (Join-Path $InstallRoot $Version) 'mangostudio.exe'
  $shimPath = Get-BinCmdPath $BinDir
  $tmp = "$shimPath.tmp.$PID"
  New-Item -ItemType Directory -Force $BinDir | Out-Null
  Set-Content -Path $tmp -Encoding ASCII -Value @('@echo off', ('"{0}" %*' -f $exePath))
  Move-Item -Path $tmp -Destination $shimPath -Force
  return $shimPath
}

function Write-NextSteps {
  Write-Host 'Run: mangostudio serve'
  Write-Host 'Then open: http://localhost:3001'
}

# Extract into a scratch directory and return its path. Never touches
# "<install_root>/<version>" — that swap only happens once the caller has
# smoke-checked these bytes, so a corrupt re-install of an already-installed
# version can never destroy the good directory it is trying to replace.
function Expand-NpmTarball([string]$ArchivePath, [string]$DestinationPath) {
  $stagingDir = "$DestinationPath.npm-staging"
  if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force }
  New-Item -ItemType Directory -Force $stagingDir | Out-Null

  try {
    & tar.exe -xzf $ArchivePath -C $stagingDir
    if ($LASTEXITCODE -ne 0) { Fail "tar.exe failed to extract $ArchivePath" }

    $packageDir = Join-Path $stagingDir 'package'
    if (-not (Test-Path $packageDir)) { Fail "npm archive is missing a package/ directory: $ArchivePath" }
    Get-ChildItem -Path $packageDir -Force | Move-Item -Destination $DestinationPath -Force
  } catch {
    Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
  Remove-Item $stagingDir -Recurse -Force
}

function Expand-InstallArchive([string]$ArchivePath, [string]$Version, [string]$InstallRoot) {
  $tempInstall = Join-Path $InstallRoot ".install-$Version-$PID"
  if (Test-Path $tempInstall) { Remove-Item $tempInstall -Recurse -Force }
  New-Item -ItemType Directory -Force $tempInstall | Out-Null

  try {
    if ($ArchivePath -like '*.tgz') {
      Expand-NpmTarball $ArchivePath $tempInstall
    } elseif ($ArchivePath -like '*.zip') {
      Expand-Archive -Path $ArchivePath -DestinationPath $tempInstall -Force
    } else {
      Fail "unsupported archive type: $ArchivePath"
    }

    if (-not (Test-Path (Join-Path $tempInstall 'mangostudio.exe'))) {
      Fail 'archive is missing mangostudio.exe'
    }
  } catch {
    Remove-Item $tempInstall -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
  return $tempInstall
}

# Run "<dir>\mangostudio.exe --version" and compare to what we meant to
# install, before the pointer moves. RemoveOnFailure=$true for a directory
# this run just created (fresh install/local/canary); $false for -Use/
# -Rollback, which reuse a directory that predates this run.
function Test-SmokeOrFail([string]$Dir, [string]$Expected, [bool]$RemoveOnFailure) {
  $exePath = Join-Path $Dir 'mangostudio.exe'
  $actual = $null
  try {
    $output = & $exePath '--version' 2>$null
    if ($output) { $actual = ($output | Select-Object -First 1).ToString().Trim() }
  } catch {
    $actual = $null
  }

  if ($actual -eq $Expected) { return }

  if ($RemoveOnFailure -and (Test-Path $Dir)) { Remove-Item -Recurse -Force $Dir }
  $received = if ($actual) { $actual } else { '<none>' }
  Fail "expected version: $Expected | received: $received"
}

# --- Actions -------------------------------------------------------------

function Complete-Install([string]$InstallRoot, [string]$BinDir, [string]$OriginKind, [string]$ArchivePath, [string]$InstallVersion, [string]$SourceKind, [string]$SourceSha) {
  $installDir = Join-Path $InstallRoot $InstallVersion
  $tempInstall = Expand-InstallArchive $ArchivePath $InstallVersion $InstallRoot
  Test-SmokeOrFail $tempInstall $InstallVersion $true

  if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
  Move-Item $tempInstall $installDir

  $oldVersion = Resolve-CurrentVersion $InstallRoot (Get-BinCmdPath $BinDir)

  $shimPath = Write-Shim $InstallRoot $InstallVersion $BinDir
  Set-CurrentJunction $InstallRoot $InstallVersion
  Save-OriginRecord -InstallRoot $InstallRoot -OriginKind $OriginKind -NewVersion $InstallVersion `
    -OldVersion $oldVersion -SourceKind $SourceKind -SourceSha $SourceSha -BinDir $BinDir

  $pathChanged = Add-UserPath $BinDir

  Write-Host "Installed MangoStudio $InstallVersion to $installDir"
  Write-Host "Created $shimPath"
  if ($pathChanged) {
    Write-Host "Added $BinDir to your user PATH. Restart open shells before running mangostudio there."
  } else {
    Write-Host "$BinDir is already on your user PATH."
  }
  Write-NextSteps
}

function Install-FromRelease([string]$InstallRoot, [string]$BinDir, [string]$OriginKind, [string]$Platform, [string]$TempDir) {
  $envVersion = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_VERSION')
  $installVersion = if ($Version) {
    Normalize-Version $Version
  } elseif (-not [string]::IsNullOrWhiteSpace($envVersion)) {
    Normalize-Version $envVersion
  } else {
    Resolve-LatestVersion
  }

  $assetName = "mangostudio-$installVersion-$Platform.zip"
  $archivePath = Join-Path $TempDir $assetName
  $checksumPath = Join-Path $TempDir 'SHA256SUMS'
  Write-Host "Downloading MangoStudio $installVersion for $Platform"
  Save-Url "$GitHubBase/releases/download/v$installVersion/$assetName" $archivePath
  Save-Url "$GitHubBase/releases/download/v$installVersion/SHA256SUMS" $checksumPath
  Test-Checksum $checksumPath $archivePath $assetName

  Complete-Install $InstallRoot $BinDir $OriginKind $archivePath $installVersion 'github-release' ''
}

function Install-FromLocalArchive([string]$InstallRoot, [string]$BinDir, [string]$OriginKind, [string]$Platform) {
  $archive = $Local
  $envVersion = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_VERSION')

  if ($archive -like '*.tgz') {
    if ([string]::IsNullOrWhiteSpace($Version) -and [string]::IsNullOrWhiteSpace($envVersion)) {
      Fail 'npm archives do not carry a version in their name; pass -Version or set MANGOSTUDIO_VERSION'
    }
    # PowerShell only accepts if/else as an expression in a direct assignment,
    # not nested inside a parenthesized argument — so the raw value is
    # resolved on its own line before normalizing it.
    $rawVersion = if ($Version) { $Version } else { $envVersion }
    $installVersion = Normalize-Version $rawVersion
    $sourceKind = 'npm-registry'
  } else {
    $installVersion = if ($Version) {
      Normalize-Version $Version
    } elseif (-not [string]::IsNullOrWhiteSpace($envVersion)) {
      Normalize-Version $envVersion
    } else {
      Get-VersionFromLocalArchive $archive $Platform
    }
    $sourceKind = 'local-archive'
  }

  Write-Host "Installing MangoStudio $installVersion from $archive"
  Complete-Install $InstallRoot $BinDir $OriginKind $archive $installVersion $sourceKind ''
}

function Install-FromCanary([string]$InstallRoot, [string]$BinDir, [string]$OriginKind, [string]$Platform, [string]$TempDir) {
  $tag = Get-CanaryTag
  $tagVersion = Normalize-Version $tag
  $assetName = "mangostudio-$tagVersion-$Platform.zip"
  $sumsPath = Join-Path $TempDir 'SHA256SUMS'
  $manifestPath = Join-Path $TempDir 'canary-manifest.json'
  $archivePath = Join-Path $TempDir $assetName

  Write-Host "Resolving canary release $tag"
  Save-Url "$GitHubBase/releases/download/$tag/SHA256SUMS" $sumsPath

  $installVersion = $tagVersion
  $sourceSha = ''
  $manifestDownloaded = $false
  try {
    Save-Url "$GitHubBase/releases/download/$tag/canary-manifest.json" $manifestPath
    $manifestDownloaded = $true
  } catch {
    $manifestDownloaded = $false
  }

  if ($manifestDownloaded) {
    # A manifest that failed to download is tolerated (fall back to the tag
    # version); a manifest that fails its checksum is not — that is a real
    # error and must not be swallowed the same way.
    Test-Checksum $sumsPath $manifestPath 'canary-manifest.json'
    $manifestVersion = Get-ManifestField $manifestPath 'version'
    if ($manifestVersion) { $installVersion = $manifestVersion }
    $sourceSha = Get-ManifestField $manifestPath 'sourceSha'
    if (-not $sourceSha) { $sourceSha = '' }
  }

  Write-Host "Downloading MangoStudio $installVersion (canary, $tag) for $Platform"
  Save-Url "$GitHubBase/releases/download/$tag/$assetName" $archivePath
  Test-Checksum $sumsPath $archivePath $assetName

  Complete-Install $InstallRoot $BinDir $OriginKind $archivePath $installVersion 'github-release' $sourceSha
}

function Invoke-Use([string]$InstallRoot, [string]$BinDir, [string]$OriginKind, [string]$Requested) {
  $requested = Normalize-Version $Requested
  $versionDir = Join-Path $InstallRoot $requested
  if (-not (Test-Path $versionDir)) { Fail "version $requested is not installed at $versionDir" }

  Test-SmokeOrFail $versionDir $requested $false

  $oldVersion = Resolve-CurrentVersion $InstallRoot (Get-BinCmdPath $BinDir)

  Write-Shim $InstallRoot $requested $BinDir | Out-Null
  Set-CurrentJunction $InstallRoot $requested
  Save-OriginRecord -InstallRoot $InstallRoot -OriginKind $OriginKind -NewVersion $requested `
    -OldVersion $oldVersion -SourceKind '' -SourceSha '' -BinDir $BinDir
  Add-UserPath $BinDir | Out-Null

  Write-Host "Now using MangoStudio $requested"
  Write-NextSteps
}

function Invoke-Rollback([string]$InstallRoot, [string]$BinDir, [string]$OriginKind) {
  $originFile = Join-Path $InstallRoot 'install-origin.json'
  if (-not (Test-Path $originFile)) { Fail 'no install-origin.json found; nothing to roll back to' }
  $record = Read-OriginRecord $originFile
  $previous = Get-Prop $record 'previousVersion'
  if ([string]::IsNullOrWhiteSpace($previous)) { Fail 'no previous version recorded to roll back to' }
  Invoke-Use $InstallRoot $BinDir $OriginKind $previous
}

function Invoke-Prune([string]$InstallRoot, [string]$BinDir) {
  $current = Resolve-CurrentVersion $InstallRoot (Get-BinCmdPath $BinDir)
  if ([string]::IsNullOrWhiteSpace($current)) { Fail 'no current version recorded; nothing to prune against' }

  $originFile = Join-Path $InstallRoot 'install-origin.json'
  $existing = Read-OriginRecord $originFile
  $previous = Get-Prop $existing 'previousVersion'

  # ForEach-Object runs its script block in a child scope, so a name this loop
  # could not remove is emitted to the pipeline rather than accumulated into an
  # outer variable via +=  — the latter would silently write to a local shadow
  # and never reach $remaining below.
  $remaining = @(Get-ChildItem -Path $InstallRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
      $name = $_.Name
      if ($name -notmatch '^\d+\.\d+\.\d+') { return }
      if ($name -eq $current) { return }
      if ($previous -and $name -eq $previous) { return }

      try {
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction Stop
        Write-Host "Removed $name"
      } catch {
        Write-Host "Could not remove $name (close editors or stop the process, then run again)"
        return $name
      }
    })

  # Leftover scratch directories from an install/upgrade that failed before
  # the swap (Expand-InstallArchive) or was interrupted mid-flight. They
  # never match the version-directory pattern above, so a plain prune leaves
  # them to accumulate forever; sweep them explicitly.
  Get-ChildItem -Path $InstallRoot -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\.(install|staging|rollback)-' } |
    ForEach-Object {
      try {
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction Stop
        Write-Host "Removed $($_.Name)"
      } catch {
        Write-Host "Could not remove $($_.Name) (close editors or stop the process, then run again)"
      }
    }

  Save-PruneRecord $InstallRoot $remaining
}

function Invoke-Uninstall([string]$InstallRoot, [string]$BinDir) {
  $removed = @()

  $cmdPath = Get-BinCmdPath $BinDir
  if (Test-Path $cmdPath) {
    $content = Get-Content -Raw -ErrorAction SilentlyContinue $cmdPath
    $ownsIt = $false
    if ($content) {
      $match = [regex]::Match($content, '"([^"]+)\\mangostudio\.exe"\s+%\*')
      if ($match.Success) {
        $versionDirParent = Normalize-PathEntry (Split-Path $match.Groups[1].Value -Parent)
        $rootFull = Normalize-PathEntry $InstallRoot
        $ownsIt = [StringComparer]::OrdinalIgnoreCase.Equals($versionDirParent, $rootFull)
      }
    }
    if ($ownsIt) {
      Remove-Item -Force $cmdPath
      $removed += $cmdPath
    }
  }

  if (Test-Path $InstallRoot) {
    Remove-Junction (Join-Path $InstallRoot 'current')
    Remove-Item -Path $InstallRoot -Recurse -Force
    $removed += $InstallRoot
  }

  $pathChanged = Remove-UserPath $BinDir

  if ($removed.Count -eq 0) {
    Write-Host 'Nothing to uninstall.'
  } else {
    foreach ($item in $removed) { Write-Host "Removed $item" }
  }
  if ($pathChanged) {
    Write-Host "Removed $BinDir from your user PATH."
  }
}

function Invoke-Main {
  if ($Help) {
    Show-Usage
    return
  }

  $installRoot = Get-InstallRoot
  $binDir = Get-BinDir $installRoot
  $envOrigin = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_INSTALL_ORIGIN')
  $originKind = if ($envOrigin -eq 'upgrade') { 'upgrade' } else { 'installer' }

  if ($Uninstall) {
    Invoke-Uninstall $installRoot $binDir
    return
  }
  if ($Prune) {
    Invoke-Prune $installRoot $binDir
    return
  }
  if ($Rollback) {
    Invoke-Rollback $installRoot $binDir $originKind
    return
  }
  if (-not [string]::IsNullOrWhiteSpace($Use)) {
    Invoke-Use $installRoot $binDir $originKind $Use
    return
  }

  # Only the archive-fetching branches below need to know the host
  # platform/architecture; -Prune/-Use/-Rollback/-Uninstall must never fail
  # because Get-Platform could not classify an unusual PROCESSOR_ARCHITECTURE.
  $platform = Get-Platform

  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "mangostudio-install-$PID"
  New-Item -ItemType Directory -Force $tempDir | Out-Null
  try {
    if (-not [string]::IsNullOrWhiteSpace($Local)) {
      Install-FromLocalArchive $installRoot $binDir $originKind $platform
    } elseif ($Canary) {
      Install-FromCanary $installRoot $binDir $originKind $platform $tempDir
    } else {
      Install-FromRelease $installRoot $binDir $originKind $platform $tempDir
    }
  } finally {
    if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
  }
}

# Run main unless the script is being dot-sourced (e.g. by unit tests that
# want the functions above without the side effects of a full install).
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-Main
}
