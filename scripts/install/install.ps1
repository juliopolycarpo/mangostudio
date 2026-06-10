#!/usr/bin/env pwsh
param(
  [string]$Local,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'juliopolycarpo/mangostudio'
$GitHubBase = "https://github.com/$Repo"

function Show-Usage {
  Write-Host 'Usage: install.ps1 [-Local archive.zip]'
  Write-Host ''
  Write-Host 'Installs MangoStudio into %LOCALAPPDATA%\mangostudio\<version>\.'
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
  $arch = $env:PROCESSOR_ARCHITECTURE
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

function Resolve-Version([string]$Platform) {
  $envVersion = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_VERSION')
  if (-not [string]::IsNullOrWhiteSpace($envVersion)) { return Normalize-Version $envVersion }
  if (-not [string]::IsNullOrWhiteSpace($Local)) { return Get-VersionFromLocalArchive $Local $Platform }
  return Resolve-LatestVersion
}

function Save-Url([string]$Url, [string]$Path) {
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
}

function Find-Checksum([string]$ManifestPath, [string]$AssetName) {
  foreach ($line in Get-Content $ManifestPath) {
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

function Get-InstallRoot {
  $override = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_INSTALL_DIR')
  if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
  return Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'mangostudio'
}

function Get-BinDir([string]$InstallRoot) {
  $override = [Environment]::GetEnvironmentVariable('MANGOSTUDIO_BIN_DIR')
  if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
  return Join-Path $InstallRoot 'bin'
}

function Install-Archive([string]$ArchivePath, [string]$Version, [string]$InstallRoot) {
  $installDir = Join-Path $InstallRoot $Version
  $tempInstall = Join-Path $InstallRoot ".install-$Version-$PID"
  if (Test-Path $tempInstall) { Remove-Item $tempInstall -Recurse -Force }
  New-Item -ItemType Directory -Force $tempInstall | Out-Null

  Expand-Archive -Path $ArchivePath -DestinationPath $tempInstall -Force
  if (-not (Test-Path (Join-Path $tempInstall 'mangostudio.exe'))) { Fail 'archive is missing mangostudio.exe' }
  if (-not (Test-Path (Join-Path $tempInstall 'public\index.html'))) { Fail 'archive is missing public\index.html' }

  if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
  Move-Item $tempInstall $installDir
  return $installDir
}

function Write-Shim([string]$InstallDir, [string]$BinDir) {
  New-Item -ItemType Directory -Force $BinDir | Out-Null
  $shimPath = Join-Path $BinDir 'mangostudio.cmd'
  $exePath = Join-Path $InstallDir 'mangostudio.exe'
  Set-Content -Path $shimPath -Encoding ASCII -Value @('@echo off', ('"{0}" %*' -f $exePath))
  return $shimPath
}

function Write-PathHint([string]$BinDir) {
  $pathParts = ($env:Path -split ';') | Where-Object { $_.Length -gt 0 }
  if ($pathParts -contains $BinDir) { return }
  Write-Host "Add $BinDir to your user PATH to run mangostudio from any shell."
}

if ($Help) {
  Show-Usage
  exit 0
}

$platform = Get-Platform
$version = Resolve-Version $platform
$assetName = "mangostudio-$version-$platform.zip"
$installRoot = Get-InstallRoot
$binDir = Get-BinDir $installRoot
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "mangostudio-install-$PID"
New-Item -ItemType Directory -Force $tempDir | Out-Null

try {
  if (-not [string]::IsNullOrWhiteSpace($Local)) {
    $archivePath = $Local
    Write-Host "Installing MangoStudio $version from $Local"
  } else {
    $archivePath = Join-Path $tempDir $assetName
    $checksumPath = Join-Path $tempDir 'SHA256SUMS'
    Write-Host "Downloading MangoStudio $version for $platform"
    Save-Url "$GitHubBase/releases/download/v$version/$assetName" $archivePath
    Save-Url "$GitHubBase/releases/download/v$version/SHA256SUMS" $checksumPath
    Test-Checksum $checksumPath $archivePath $assetName
  }

  $installDir = Install-Archive $archivePath $version $installRoot
  $shimPath = Write-Shim $installDir $binDir
  Write-Host "Installed MangoStudio $version to $installDir"
  Write-Host "Created $shimPath"
  Write-PathHint $binDir
} finally {
  if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
}
