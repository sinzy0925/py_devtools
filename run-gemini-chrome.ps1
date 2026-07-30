# Start Chrome (CDP) then run Gemini CLI with chrome-devtools MCP.
# Standing instructions: edit .gemini/GEMINI.md
# Optional full system override: --system-prompt-file .\path\to\system.md
# Example:
#   .\run-gemini-chrome.ps1 --model gemini-3.5-flash-lite --prompt "現在開いてるchromeで、duckduckgoでAIを検索して、最初のページを開き、内容を要約して"
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot
$env:PYTHONUNBUFFERED = "1"

# Load repository .env (GEMINI_API_KEY, CDP_*, etc.) into this process.
$EnvFile = Join-Path $RepoRoot ".env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $k, $v = $_ -split '=', 2
    Set-Item -Path "Env:$($k.Trim())" -Value ($v.Trim().Trim('"').Trim("'"))
  }
}

$pyArgs = @("-u", ".\run_gemini_chrome.py") + $args

if (Get-Command python -ErrorAction SilentlyContinue) {
  & python @pyArgs
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 @pyArgs
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
  & python3 @pyArgs
} else {
  throw "Python not found"
}
exit $LASTEXITCODE
