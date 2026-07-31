# Launch Chrome with remote debugging for CDP / chrome-devtools MCP
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

$EnvFile = Join-Path $RepoRoot ".env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $k, $v = $_ -split '=', 2
    $value = $v.Trim().Trim('"').Trim("'")
    Set-Item -Path "Env:$($k.Trim())" -Value $value
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node.js 20+ and retry."
}

$LocalTsx = Join-Path $RepoRoot "node_modules\.bin\tsx.cmd"
$Entry = ".\src\start-chrome-cdp.ts"
if (Test-Path $LocalTsx) {
  & $LocalTsx $Entry
} else {
  & npx --yes tsx $Entry
}
exit $LASTEXITCODE
