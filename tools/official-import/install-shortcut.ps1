<#
  デスクトップに「UBER_LOG」ショートカットを作成（初回のみ・再実行しても上書き更新されるだけ）
  ショートカット → wscript.exe tools\official-import\launcher.vbs（画面を出さずにローカルbackendを起動し、公式取込画面を開く）
  UBER_LOG フォルダやデータは移動しない。

  実行: powershell -NoProfile -ExecutionPolicy Bypass -File tools\official-import\install-shortcut.ps1
#>
param([string]$Name = 'UBER_LOG')

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcher = Join-Path $PSScriptRoot 'launcher.vbs'
$icon = Join-Path $PSScriptRoot 'uber-log.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = "`"$launcher`""
$lnk.WorkingDirectory = $root
$lnk.Description = 'UBER_LOG 公式取込（ローカル）'
if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
$lnk.Save()

Write-Host "デスクトップにショートカットを作成しました: $lnkPath"
