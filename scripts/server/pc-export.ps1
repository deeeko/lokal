# Run on the Windows PC, ONCE, when the agent moves to the server (docs/SERVER.md). Windows PowerShell 5.1 or later.
#   powershell -ExecutionPolicy Bypass -File scripts\server\pc-export.ps1 -Server ubuntu@203.0.113.10 [-SshKey C:\path\oracle.key]
#
# 1. Refuses while the PC agent runs (agent.lock exists, or a node process runs src/agent.mjs).
# 2. Writes server-migration-manifest.txt: the SHA-256 of every state file present here. On the server, setup.sh
#    checks the copies against it, so the server starts from exactly the PC's records (exactly-once depends on them).
# 3. Seals this PC: writes an agent.lock that names another computer ("moved-to-server"), so every --execute command
#    and autopilot on this PC is refused from now on. Only ONE agent may ever run.
# 4. Prints the scp commands that copy the files. It never opens agent.json or status-secret; it only checks they exist.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$SshKey = ""
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$lock = Join-Path $root "agent.lock"

# The same lists as scripts/server/lib.sh
$required = @("contacts.json", "receipts.jsonl", "watch-state.json")
$records = @("requests.json", "registrations-state.json", "ntag-payments.json", "contract-payments.json", "refunds.json")
$queues = @("status-outbox.jsonl", "status-outbox.sent.json", "alerts-outbox.jsonl", "alerts-outbox.sent.json")

if (Test-Path $lock) {
  $text = Get-Content -Raw $lock
  if ($text -match '"moved-to-server"') {
    Write-Host "This PC is already sealed (the agent moved to the server). The manifest was written then; nothing to do." -ForegroundColor Yellow
    Write-Host "To export again (only if the server never ran yet), delete $lock first."
    exit 1
  }
  Write-Host "STOPPED: $lock exists: the agent (or an --execute command) is running, or it crashed." -ForegroundColor Red
  Write-Host "Stop it with Ctrl+C in its window. If it crashed, check its last payout on Celoscan, then delete agent.lock and run this again."
  exit 1
}
$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'agent\.mjs' })
if ($running.Count -gt 0) {
  Write-Host "STOPPED: a node process runs src/agent.mjs (pid $($running[0].ProcessId)). Stop it first." -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $root "contacts.json"))) {
  Write-Host "STOPPED: contacts.json is not in $root. Run this from the folder the agent runs in." -ForegroundColor Red
  exit 1
}

$present = @()
$lines = @()
foreach ($name in ($required + $records + $queues)) {
  $p = Join-Path $root $name
  if (Test-Path $p -PathType Leaf) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()
    $lines += "$hash  $name"
    $present += $name
  } elseif ($required -contains $name) {
    Write-Host "Note: $name does not exist on this PC (fine only if the agent never paid or never ran with --execute)." -ForegroundColor Yellow
  }
}
$manifest = Join-Path $root "server-migration-manifest.txt"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifest, (($lines -join "`n") + "`n"), $utf8)

$keyDir = Join-Path $env:USERPROFILE ".celo-naira-agent"
foreach ($s in @("agent.json", "status-secret")) {
  if (-not (Test-Path (Join-Path $keyDir $s) -PathType Leaf)) { Write-Host "Missing: $keyDir\$s (the server needs it)." -ForegroundColor Red }
}

# Seal this PC: a lock from "another computer" makes every --execute command here refuse (src/lock.mjs, "foreign").
$seal = [ordered]@{ pid = 1; host = "moved-to-server"; startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); command = "moved to the server $Server - never run the agent on this PC again" }
[System.IO.File]::WriteAllText($lock, (($seal | ConvertTo-Json -Compress) + "`n"), $utf8)

$i = ""
if ($SshKey) { $i = "-i `"$SshKey`" " }
$files = (($present + "server-migration-manifest.txt") | ForEach-Object { "`"$(Join-Path $root $_)`"" }) -join " "
Write-Host ""
Write-Host "Wrote server-migration-manifest.txt ($($present.Count) state files) and sealed this PC (agent.lock)." -ForegroundColor Green
Write-Host "Do NOT start the agent on this PC again. Now copy, in this order:"
Write-Host ""
Write-Host "  ssh $i$Server `"mkdir -p -m 700 .celo-naira-agent`""
Write-Host "  scp $i`"$keyDir\agent.json`" `"$keyDir\status-secret`" ${Server}:.celo-naira-agent/"
Write-Host "  scp $i$files ${Server}:lokal/"
Write-Host ""
Write-Host "Then on the server:  bash ~/lokal/scripts/server/setup.sh --start"
Write-Host "Files copied: $($present -join ', ')"
