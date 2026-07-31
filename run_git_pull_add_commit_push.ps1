# git pull → add → commit → push（日時は実行時に自動取得）
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$timestamp = Get-Date -Format "yyyy/MM/dd HH:mm"
$commitMessage = "git pull && add commit push $timestamp"

git pull

Write-Host "- - - - - - - - - - -"
Write-Host "git pull && git add commit push"
Write-Host "- - - - - - - - - - -"

git add .
git commit -m $commitMessage
git push -u origin main
