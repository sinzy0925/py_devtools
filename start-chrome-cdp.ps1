# Launch Chrome with remote debugging for CDP / chrome-devtools MCP
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $RepoRoot ".env"

if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $k, $v = $_ -split '=', 2
    $value = $v.Trim().Trim('"').Trim("'")
    Set-Item -Path "Env:$($k.Trim())" -Value $value
  }
}

$HostAddr = if ($env:CDP_HOST) { $env:CDP_HOST } else { "127.0.0.1" }
$Port = if ($env:CDP_PORT) { $env:CDP_PORT } else { "9222" }
$ProfileRel = if ($env:CHROME_USER_DATA_DIR) { $env:CHROME_USER_DATA_DIR } else { "./chrome-profile" }
$Profile = if ([System.IO.Path]::IsPathRooted($ProfileRel)) { $ProfileRel } else { Join-Path $RepoRoot ($ProfileRel -replace '^\./', '') }

$Chrome = @(
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $Chrome) { throw "Chrome not found" }

New-Item -ItemType Directory -Force -Path $Profile | Out-Null

try {
  $null = Invoke-WebRequest -Uri "http://${HostAddr}:${Port}/json/version" -UseBasicParsing -TimeoutSec 1
  Write-Host "CDP already listening at http://${HostAddr}:${Port}"
  exit 0
} catch {}

Start-Process -FilePath $Chrome -ArgumentList @(
  "--remote-debugging-address=$HostAddr",
  "--remote-debugging-port=$Port",
  "--user-data-dir=$Profile",
  "--no-first-run",
  "--no-default-browser-check"
)

Write-Host "Chrome started: CDP http://${HostAddr}:${Port}"
Write-Host "Profile: $Profile"
