<#
  UBER_LOG 公式取込 — 最新日付の自動判定＋Claude Code 起動（UBER取込.cmd から呼ばれる入口）

  1. tools/official-import/inbox/ の YYYY-MM-DD フォルダ（有効な日付・今日以前）から最新日を選ぶ
  2. activity.txt と screenshots/ の画像（1枚以上）があるか確認
  3. UBER_LOG 直下で Claude Code を対話セッションとして起動し、最初の指示に「/uber-import <日付>」を渡す
     （Claude Code 2.1.280 の `claude [prompt]`: "starts an interactive session by default"。
       取込中の質問にもそのまま同じ画面で回答できる）

  取込処理そのもの（prepare / validate / apply / test / report / HANDOFF / commit / push）は
  既存の /uber-import（.claude/commands/uber-import.md）が行う。このスクリプトは入口のみ。

  テスト用パラメータ: -InboxDir / -Today / -ClaudeCommand / -DryRun / -NoPause
#>
param(
  [string]$InboxDir = '',
  [string]$Today = '',
  [string]$ClaudeCommand = 'claude',
  [switch]$DryRun,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $InboxDir) { $InboxDir = Join-Path $PSScriptRoot 'inbox' }
$line = '===================================='

function Wait-User {
  if (-not $NoPause) {
    Write-Host ''
    Write-Host 'このウィンドウを閉じるには何かキーを押してください...'
    try { [void][Console]::ReadKey($true) } catch { Read-Host | Out-Null }
  }
}

function Stop-WithError([string]$target, [string]$message) {
  Write-Host '--------------------------------'
  Write-Host 'UBER_LOG 公式取込'
  if ($target) { Write-Host "対象: $target" }
  Write-Host ''
  Write-Host 'エラー:' -ForegroundColor Red
  Write-Host $message -ForegroundColor Red
  Write-Host '--------------------------------'
  Wait-User
  exit 1
}

# ---------- 1. 最新日付の自動判定 ----------
if ($Today) {
  $todayDate = [datetime]::ParseExact($Today, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
} else {
  $todayDate = (Get-Date).Date
}

if (-not (Test-Path -LiteralPath $InboxDir -PathType Container)) {
  Stop-WithError '' "取込フォルダがありません: $InboxDir`n取込画面（tools\official-import\index.html）で「取込データを保存」してください。"
}

$candidates = @()
$futureDirs = @()
foreach ($dir in Get-ChildItem -LiteralPath $InboxDir -Directory) {
  if ($dir.Name -notmatch '^\d{4}-\d{2}-\d{2}$') { continue }
  $parsed = [datetime]::MinValue
  $ok = [datetime]::TryParseExact($dir.Name, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$parsed)
  if (-not $ok) { continue }                       # 2026-13-01 など存在しない日付は無視
  if ($parsed -gt $todayDate) { $futureDirs += $dir.Name; continue }
  $candidates += [pscustomobject]@{ Name = $dir.Name; Date = $parsed }
}

foreach ($f in $futureDirs) {
  Write-Host "警告: 未来日のフォルダ $f は自動選択しません（日付を確認してください）" -ForegroundColor Yellow
}
if ($candidates.Count -eq 0) {
  Stop-WithError '' "取込できる日付フォルダ（YYYY-MM-DD）がありません: $InboxDir`n取込画面で「取込データを保存」してください。"
}
$target = ($candidates | Sort-Object Date -Descending | Select-Object -First 1).Name
$dayDir = Join-Path $InboxDir $target

# ---------- 2. 実行前チェック ----------
$activity = Join-Path $dayDir 'activity.txt'
if (-not (Test-Path -LiteralPath $activity -PathType Leaf)) {
  Stop-WithError $target 'activity.txt がありません'
}
if ((Get-Item -LiteralPath $activity).Length -eq 0) {
  Stop-WithError $target 'activity.txt が空です'
}
$shotDir = Join-Path $dayDir 'screenshots'
if (-not (Test-Path -LiteralPath $shotDir -PathType Container)) {
  Stop-WithError $target 'screenshots フォルダがありません'
}
$shots = @(Get-ChildItem -LiteralPath $shotDir -File | Where-Object { $_.Extension -match '^\.(png|jpe?g)$' })
if ($shots.Count -eq 0) {
  Stop-WithError $target 'screenshots フォルダに画像（PNG / JPG）がありません'
}

# ---------- 3. Claude Code ----------
$claude = Get-Command $ClaudeCommand -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $claude) {
  Stop-WithError $target "Claude Codeが見つかりません（コマンド「$ClaudeCommand」が PATH にありません）。`nClaude Code をインストール・ログインしてから、もう一度実行してください。"
}

$prompt = "/uber-import $target"

Write-Host $line
Write-Host ' UBER_LOG 公式取込'
Write-Host $line
Write-Host ''
Write-Host '対象日:'
Write-Host $target
Write-Host ''
Write-Host 'activity.txt:'
Write-Host 'OK'
Write-Host ''
Write-Host 'screenshots:'
Write-Host "$($shots.Count)枚"
Write-Host ''
Write-Host 'Claude Codeを起動します...'
Write-Host ''
Write-Host $prompt
Write-Host ''
Write-Host $line
Write-Host '※ 取込中に Claude から質問や許可の確認が出たら、この画面で回答してください。'
Write-Host '※ 完了したら /exit で Claude Code を終了すると、このウィンドウを閉じられます。'
Write-Host ''

if ($DryRun) {
  Write-Host "[DryRun] 起動コマンド: $($claude.Source) `"$prompt`"  （作業フォルダ: $root）"
  exit 0
}

Set-Location -LiteralPath $root
& $claude.Source $prompt
$code = $LASTEXITCODE

Write-Host ''
Write-Host $line
Write-Host " UBER_LOG 公式取込: Claude Code を終了しました（対象日 $target / 終了コード $code）"
Write-Host ' 取込結果は上の Claude Code の表示を確認してください。'
Write-Host $line
Wait-User
exit $code
