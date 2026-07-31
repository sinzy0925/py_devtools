# Start Chrome (CDP) then run Gemini CLI with chrome-devtools MCP.
# Standing instructions: edit .gemini/GEMINI.md
# Optional full system override: --system-prompt-file .\path\to\system.md
# Example (model from .env GEMINI_MODEL, or pass --model to override):
#   .\run-gemini-chrome.ps1 --prompt "現在開いてるchromeで、duckduckgoでAIを検索して、最初のページを開き、内容を要約して"
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

# Load repository .env (GOOGLE_API_KEY, CDP_*, etc.) into this process.
$EnvFile = Join-Path $RepoRoot ".env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $k, $v = $_ -split '=', 2
    Set-Item -Path "Env:$($k.Trim())" -Value ($v.Trim().Trim('"').Trim("'"))
  }
}
# Prefer GOOGLE_API_KEY; drop stale GEMINI_API_KEY from older sessions.
if ($env:GOOGLE_API_KEY) {
  Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node.js 20+ and retry."
}

$LocalTsx = Join-Path $RepoRoot "node_modules\.bin\tsx.cmd"
$Entry = ".\src\run-gemini-chrome.ts"
if (Test-Path $LocalTsx) {
  & $LocalTsx $Entry @args
} else {
  & npx --yes tsx $Entry @args
}
exit $LASTEXITCODE
