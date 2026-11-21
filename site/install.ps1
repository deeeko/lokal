# Lokal (formerly Naira Payout): install the `ntag` command on Windows.
#
#   irm https://lokalpay.vercel.app/install.ps1 | iex
#
# You can read this whole file before running it. What it does:
#   1. Checks that Node.js 20 or newer is installed. If not, it tells you how to get it and stops.
#      It never installs system software for you.
#   2. Downloads the ntag code from GitHub (github.com/deeeko/celo-naira-payout-agent) as a zip.
#   3. Installs the libraries the command line needs with npm, at the exact versions in package-lock.json
#      (no install scripts are run; libraries only the website uses are skipped).
#   4. Puts the code in  %LOCALAPPDATA%\lokal\app  (replacing an older copy in one step)
#      and a small launcher in  %LOCALAPPDATA%\lokal\bin\ntag.cmd
#   5. Adds that bin folder to YOUR user PATH, so `ntag` works in any new terminal.
#   6. Cleans up an install from before the rename to Lokal: removes %LOCALAPPDATA%\naira-payout\app and \bin
#      and takes that old bin folder out of your user PATH.
#
# What it never does:
#   - It never needs administrator rights.
#   - It never creates, reads, moves or deletes your wallet. The wallet is a separate file,
#     %USERPROFILE%\.lokal\wallet.json, so updating or uninstalling ntag keeps it. A wallet made before the
#     rename stays at %USERPROFILE%\.naira-payout\wallet.json and ntag keeps using it there.
#   - It never sends any transaction.
#
# Options (set before running; they are environment variables because `irm | iex` cannot take arguments):
#   $env:NTAG_REF = "v1.0.0"   install a specific branch, tag or commit instead of "main"
#   $env:NTAG_NO_PATH = "1"    do not change your PATH; print what to add instead
#   $env:NTAG_UNINSTALL = "1"  remove ntag (the app and bin folders and the PATH entry; never the wallet)
#
# Update: run the same one-liner again. Uninstall:
#   $env:NTAG_UNINSTALL = "1"; irm https://lokalpay.vercel.app/install.ps1 | iex
#
# Works in Windows PowerShell 5.1 and PowerShell 7. Everything runs inside one script block, so if the
# download of this file is cut off halfway, PowerShell refuses to parse it and nothing runs at all.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads very slow in PowerShell 5.1

  # ---------------------------------------------------------------------------------------------
  # Settings
  # ---------------------------------------------------------------------------------------------
  $Repo    = 'deeeko/celo-naira-payout-agent'
  $Ref     = if ($env:NTAG_REF) { $env:NTAG_REF.Trim() } else { 'main' }
  $MinNode = 20
  $SiteUrl = 'https://lokalpay.vercel.app'
  $OneLine = "irm $SiteUrl/install.ps1 | iex"

  function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
  function Step([string]$Text) { Write-Host "  - $Text" -ForegroundColor Cyan }
  function Fail([string]$Text) { throw [System.InvalidOperationException]::new($Text) }

  # Normalises a folder for comparing PATH entries: no quotes, no trailing backslash, any case.
  function Format-PathEntry([string]$Dir) { return $Dir.Trim().Trim('"').TrimEnd('\').ToLowerInvariant() }

  # True if the PATH text already contains $Dir.
  function Test-PathEntry([string]$PathText, [string]$Dir) {
    return [bool](@(([string]$PathText) -split ';' | Where-Object { (Format-PathEntry $_) -eq (Format-PathEntry $Dir) }).Count)
  }

  # Returns the PATH text with $Dir added at the end (unchanged if it is already there).
  function Add-PathEntry([string]$PathText, [string]$Dir) {
    $parts = @(([string]$PathText) -split ';' | Where-Object { $_.Trim() -ne '' })
    foreach ($p in $parts) {
      if ((Format-PathEntry $p) -eq (Format-PathEntry $Dir)) { return ($parts -join ';') }
    }
    return (@($parts) + $Dir) -join ';'
  }

  # Returns the PATH text without $Dir (and without empty entries).
  function Remove-PathEntry([string]$PathText, [string]$Dir) {
    $keep = @(([string]$PathText) -split ';' | Where-Object { $_.Trim() -ne '' -and (Format-PathEntry $_) -ne (Format-PathEntry $Dir) })
    return ($keep -join ';')
  }

  # The user PATH is read and written in the registry as-is, so entries such as %USERPROFILE%\bin
  # stay unexpanded. Only HKEY_CURRENT_USER is touched, which needs no administrator rights.
  function Get-UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    if ($null -eq $key) { return '' }
    try { return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Close() }
  }
  function Set-UserPath([string]$PathText) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try { $key.SetValue('Path', $PathText, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Close() }
    # Tell Windows (Explorer, new terminals) that the environment changed. Setting and clearing a
    # throwaway variable with [Environment]::SetEnvironmentVariable sends that notice for us.
    [Environment]::SetEnvironmentVariable('LOKAL_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('LOKAL_PATH_REFRESH', $null, 'User')
  }

  # Moves a folder, retrying briefly: antivirus scanners often hold new files open for a moment.
  function Move-Folder([string]$From, [string]$To) {
    for ($i = 1; ; $i++) {
      try { [System.IO.Directory]::Move($From, $To); return }
      catch { if ($i -ge 5) { throw } ; Start-Sleep -Milliseconds 800 }
    }
  }

  # Deletes a folder if it exists. Returns $false (instead of failing) if something keeps it open.
  function Remove-Folder([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return $true }
    for ($i = 1; $i -le 3; $i++) {
      try { Remove-Item -LiteralPath $Dir -Recurse -Force; return $true }
      catch { Start-Sleep -Milliseconds 800 }
    }
    return -not (Test-Path -LiteralPath $Dir)
  }

  # Runs a program (npm, node) and returns its exit code and output, without PowerShell 5.1 turning
  # anything it prints to stderr into an error.
  function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
      return [pscustomobject]@{ Code = $LASTEXITCODE; Output = (@($out) -join "`n") }
    } finally { $ErrorActionPreference = $eap }
  }

  # Where things go. The wallet is NOT here: it lives in your user folder (see the end of this script).
  if (-not $env:LOCALAPPDATA) { Say 'Could not find your local app data folder (%LOCALAPPDATA% is not set).' Red; return }
  $Root       = Join-Path $env:LOCALAPPDATA 'lokal'
  $App        = Join-Path $Root 'app'
  $Bin        = Join-Path $Root 'bin'
  $Shim       = Join-Path $Bin 'ntag.cmd'
  # Where installs went before the rename to Lokal. Cleaned up on install, update and uninstall.
  $OldRoot    = Join-Path $env:LOCALAPPDATA 'naira-payout'
  $OldApp     = Join-Path $OldRoot 'app'
  $OldBin     = Join-Path $OldRoot 'bin'
  # Shown in messages only. USERPROFILE can be unset (some service accounts); never let that stop the script here.
  # ntag uses %USERPROFILE%\.lokal\wallet.json, or the wallet from before the rename if only that one exists.
  $WalletFile = '%USERPROFILE%\.lokal\wallet.json'
  if ($env:USERPROFILE) {
    $WalletFile = Join-Path $env:USERPROFILE '.lokal\wallet.json'
    $OldWallet  = Join-Path $env:USERPROFILE '.naira-payout\wallet.json'
    if (-not (Test-Path -LiteralPath $WalletFile) -and (Test-Path -LiteralPath $OldWallet)) { $WalletFile = $OldWallet }
  }
  $Stage      = $null
  $NoPath     = [bool]($env:NTAG_NO_PATH -and $env:NTAG_NO_PATH -ne '0')
  $Uninstall  = [bool]($env:NTAG_UNINSTALL -and $env:NTAG_UNINSTALL -ne '0')

  # Leftovers of an interrupted run: staging folders named .new-xxxxxxxx and .old-xxxxxxxx.
  function Get-Leftovers {
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Directory -Force | Where-Object { $_.Name -like '.new-*' -or $_.Name -like '.old-*' } | ForEach-Object { $_.FullName })
  }

  # Removes an install from before the rename to Lokal (%LOCALAPPDATA%\naira-payout): its app and bin folders,
  # leftovers of an interrupted run, and its bin folder in the user PATH and in this window's PATH. Never a wallet:
  # wallets were never stored there. Returns $true if anything was found.
  function Remove-OldInstall {
    $found = $false
    if (-not $NoPath) {
      $userPath = Get-UserPath
      if (Test-PathEntry $userPath $OldBin) { Set-UserPath (Remove-PathEntry $userPath $OldBin); $found = $true; Step "Removed the old naira-payout bin folder from your user PATH" }
    } elseif (Test-PathEntry (Get-UserPath) $OldBin) {
      $found = $true
      Step 'Left your PATH alone (NTAG_NO_PATH is set). Remove the old bin folder from it yourself:'
      Say "      $OldBin"
    }
    $env:Path = Remove-PathEntry $env:Path $OldBin
    if (Test-Path -LiteralPath $OldRoot) {
      $old = @($OldApp, $OldBin) + @(Get-ChildItem -LiteralPath $OldRoot -Directory -Force | Where-Object { $_.Name -like '.new-*' -or $_.Name -like '.old-*' } | ForEach-Object { $_.FullName })
      foreach ($dir in $old) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $found = $true
        if (Remove-Folder $dir) { Step "Removed the old install folder $dir" } else { Say "  Could not remove $dir yet (is an old ntag window open?). Delete it later; it is no longer used." DarkGray }
      }
      if (-not (Get-ChildItem -LiteralPath $OldRoot -Force)) { Remove-Item -LiteralPath $OldRoot -Force }
    }
    return $found
  }

  Say ''
  # ---------------------------------------------------------------------------------------------
  # Uninstall ($env:NTAG_UNINSTALL = "1")
  # ---------------------------------------------------------------------------------------------
  if ($Uninstall) {
    Say 'Lokal: uninstalling the ntag command' White
    Say "This removes $App, $Bin and the PATH entry. Your wallet file is not touched."
    Say ''
    try {
      $ok = $true
      # Remove the app, the launcher, and any leftovers from an interrupted install.
      foreach ($dir in @($App, $Bin) + @(Get-Leftovers)) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        if (Remove-Folder $dir) { Step "Removed $dir" } else { $ok = $false; Say "  Could not remove $dir. Close any window running ntag and run the uninstall again." Yellow }
      }
      # Remove the lokal folder itself if nothing else is left in it.
      if ((Test-Path -LiteralPath $Root) -and -not (Get-ChildItem -LiteralPath $Root -Force)) { Remove-Item -LiteralPath $Root -Force }

      # Take the bin folder out of the user PATH and out of this window's PATH.
      if ($NoPath) {
        Step 'Left your PATH alone (NTAG_NO_PATH is set). If you added the bin folder yourself, remove it:'
        Say "      $Bin"
      } else {
        $userPath = Get-UserPath
        if (Test-PathEntry $userPath $Bin) { Set-UserPath (Remove-PathEntry $userPath $Bin); Step 'Removed the bin folder from your user PATH' }
        else { Step 'Your user PATH did not contain the bin folder' }
      }
      $env:Path = Remove-PathEntry $env:Path $Bin
      # And anything left from an install made before the rename to Lokal.
      $null = Remove-OldInstall

      Say ''
      if ($ok) { Say 'ntag is uninstalled.' Green } else { Say 'ntag is partly uninstalled (see above).' Yellow }
      Say "Your wallet is still at $WalletFile (if you created one)."
      Say 'Keep it, or back it up before deleting it: without that file and its send password the money in it is lost.'
      Say ''
    } catch {
      Say "Uninstall failed: $($_.Exception.Message)" Red
    }
    return
  }

  # ---------------------------------------------------------------------------------------------
  # Install
  # ---------------------------------------------------------------------------------------------
  Say 'Lokal: installing the ntag command' White
  Say "  1. Check Node.js $MinNode or newer      2. Download ntag ($Ref) from GitHub"
  Say '  3. Install its libraries with npm    4. Add "ntag" to your PATH'
  Say "Into $Root. No admin rights needed; your wallet is never touched."
  Say ''

  try {
    # --- Step 1: Node.js ---------------------------------------------------------------------
    # ntag is a Node.js program. We only check for it: installing Node is your choice.
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodeVersion = $null
    if ($node) {
      $r = Invoke-Native $node.Source @('--version')
      if ($r.Code -eq 0 -and $r.Output -match 'v(\d+)\.(\d+)\.(\d+)') { $nodeVersion = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" }
    }
    if (-not $nodeVersion -or $nodeVersion.Major -lt $MinNode) {
      if ($nodeVersion) { Say "ntag needs Node.js $MinNode or newer. You have $nodeVersion." Yellow }
      else { Say "ntag needs Node.js $MinNode or newer, and it is not installed (or not on your PATH)." Yellow }
      Say ''
      Say 'Install it one of these ways, then open a NEW PowerShell window and run this installer again:'
      Say '  winget install OpenJS.NodeJS.LTS' White
      Say '  or download the LTS installer from https://nodejs.org' White
      Say ''
      Say "Then: $OneLine"
      Say ''
      return
    }
    # npm comes with Node. Use npm.cmd: npm.ps1 is blocked on PCs where scripts are disabled.
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) { Fail "Node.js $nodeVersion is installed but npm was not found next to it. Reinstall Node.js from https://nodejs.org, then run this again." }
    Step "Node.js $nodeVersion found"

    # --- Step 2: download ----------------------------------------------------------------------
    # The ref is a branch, tag or commit name; reject anything else so it is safe in a URL.
    if ($Ref -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' -or $Ref -match '\.\.') { Fail "NTAG_REF `"$Ref`" is not a valid branch, tag or commit name." }
    $zipUrl = "https://codeload.github.com/$Repo/zip/$Ref"

    # Windows PowerShell 5.1 may default to old TLS versions that GitHub refuses.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

    $null = New-Item -ItemType Directory -Force -Path $Root
    # Clean up anything an interrupted earlier run left behind (folders starting with a dot).
    foreach ($dir in Get-Leftovers) { $null = Remove-Folder $dir }

    # Everything new is built in a staging folder next to app\, so the final swap is a quick rename.
    $Stage = Join-Path $Root ('.new-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $null = New-Item -ItemType Directory -Path $Stage
    $zip = Join-Path $Stage 'ntag.zip'
    try {
      Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 180
    } catch {
      $status = 0
      try { $status = [int]$_.Exception.Response.StatusCode } catch { }
      if ($status -eq 404) { Fail "GitHub has no branch, tag or commit called `"$Ref`" in $Repo. Check NTAG_REF, or clear it to install main: Remove-Item Env:NTAG_REF" }
      if ($status -gt 0) { Fail "GitHub answered with error $status while downloading ntag. Try again in a few minutes." }
      Fail "Could not download ntag from GitHub. Check your internet connection (and any proxy or firewall), then try again. Details: $($_.Exception.Message)"
    }
    Step "Downloaded $Repo ($Ref)"

    # Unpack. The zip holds one top folder (for example celo-naira-payout-agent-main).
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $unzipped = Join-Path $Stage 'src'
    try { [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $unzipped) }
    catch { Fail "The download looks damaged (it is not a valid zip). Run the installer again. Details: $($_.Exception.Message)" }
    Remove-Item -LiteralPath $zip -Force
    $top = @(Get-ChildItem -LiteralPath $unzipped -Directory)
    if ($top.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $top[0].FullName 'src\ntag.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $top[0].FullName 'package-lock.json'))) {
      Fail "The download for `"$Ref`" does not contain the ntag command (src\ntag.mjs). Use a newer NTAG_REF, or clear it to install main."
    }
    $NewApp = $top[0].FullName

    # --- Step 3: libraries -----------------------------------------------------------------------
    # npm ci installs the exact versions pinned in package-lock.json. --ignore-scripts means no
    # package can run code while installing; --omit=dev skips test-only tools.
    Step 'Installing libraries with npm (about a minute the first time)'
    Push-Location -LiteralPath $NewApp
    try { $r = Invoke-Native $npm.Source @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error') }
    finally { Pop-Location }
    if ($r.Code -ne 0) {
      $tail = (($r.Output -split "`n") | Select-Object -Last 15) -join "`n"
      Fail "npm could not install the libraries (exit code $($r.Code)). Check your internet connection and try again. npm said:`n$tail"
    }

    # Make sure the new copy actually runs before it replaces the old one.
    $r = Invoke-Native $node.Source @((Join-Path $NewApp 'src\ntag.mjs'), 'help')
    if ($r.Code -ne 0) { Fail "The downloaded ntag did not start (exit code $($r.Code)). Your previous install, if any, was kept. Output:`n$($r.Output)" }

    # --- Step 4: put it in place -----------------------------------------------------------------
    # Swap: old app -> .old-xxxx, new app -> app, then delete the old one. If the second rename
    # fails, the old app is put back, so you never end up with half an install.
    $Old = $null
    if (Test-Path -LiteralPath $App) {
      $Old = Join-Path $Root ('.old-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
      try { Move-Folder $App $Old }
      catch { Fail "Could not replace the installed ntag in $App. Close any window that is running ntag (or has that folder open) and run the installer again." }
    }
    try { Move-Folder $NewApp $App }
    catch {
      if ($Old) { try { Move-Folder $Old $App } catch { } }
      Fail "Could not move the new ntag into $App. Details: $($_.Exception.Message)"
    }
    if ($Old -and -not (Remove-Folder $Old)) { Say "  (Could not delete the old copy in $Old yet; the next run cleans it up.)" DarkGray }
    $null = Remove-Folder $Stage
    $Stage = $null
    Step "Installed in $App"

    # The launcher: a two-line .cmd file that runs node on app\src\ntag.mjs with all your arguments.
    # (A .cmd file, not a .ps1, so it works even where PowerShell scripts are disabled.)
    $null = New-Item -ItemType Directory -Force -Path $Bin
    $shimText = @(
      '@echo off',
      'rem ntag launcher, written by https://lokalpay.vercel.app/install.ps1',
      'rem Runs the ntag command from the app folder next to this one. Your wallet is not stored here.',
      'where node >nul 2>nul || (echo ntag needs Node.js 20 or newer: https://nodejs.org 1>&2 & exit /b 1)',
      'node "%~dp0..\app\src\ntag.mjs" %*'
    ) -join "`r`n"
    [System.IO.File]::WriteAllText($Shim, $shimText + "`r`n", [System.Text.Encoding]::ASCII)
    Step "Created $Shim"

    # --- Step 5: PATH --------------------------------------------------------------------------
    if ($NoPath) {
      Step 'Left your PATH alone (NTAG_NO_PATH is set). To use "ntag" by name, add this folder to your PATH:'
      Say "      $Bin"
    } else {
      $userPath = Get-UserPath
      if (-not (Test-PathEntry $userPath $Bin)) { Set-UserPath (Add-PathEntry $userPath $Bin); Step 'Added the bin folder to your user PATH' }
      else { Step 'The bin folder is already on your user PATH' }
      # This window too, so you can use ntag right away.
      $env:Path = Add-PathEntry $env:Path $Bin
    }

    # Updating from an install made before the rename to Lokal: take the old naira-payout bin folder out of PATH
    # (so the old ntag can't shadow this one) and delete the old copy.
    if (Remove-OldInstall) { Step 'Cleaned up the install from before the rename (Naira Payout is now Lokal)' }

    # Final check, through the launcher itself.
    $r = Invoke-Native $Shim @('help')
    if ($r.Code -ne 0) { Fail "ntag was installed but did not start through $Shim (exit code $($r.Code)). Output:`n$($r.Output)" }

    # Warn if another "ntag" (for example from `npm link` in a checkout) comes first on the PATH.
    $first = Get-Command ntag -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($first -and -not $NoPath -and ((Format-PathEntry (Split-Path -Parent $first.Source)) -ne (Format-PathEntry $Bin))) {
      Say "  Note: another ntag comes first on your PATH: $($first.Source). Remove it (npm unlink -g) to use this one." Yellow
    }
  } catch {
    Say ''
    Say "Install failed: $($_.Exception.Message)" Red
    Say 'Nothing was changed outside the lokal folder, and your wallet was not touched.' Gray
    Say "Run it again: $OneLine"
    Say ''
    if ($Stage) { $null = Remove-Folder $Stage }
    return
  }

  # ---------------------------------------------------------------------------------------------
  # Done: next steps
  # ---------------------------------------------------------------------------------------------
  Say ''
  Say 'ntag is installed.' Green
  Say ''
  Say 'Next steps (in PowerShell, leave out the @ or put the tag in quotes: ada or ''@ada''):' White
  Say '  ntag wallet new          create your wallet, protected by a send password you choose'
  Say '  ntag wallet              shows your address: send it some USDT (Tether on Celo) and a little CELO for fees'
  Say '  ntag whois ada           who owns @ada'
  Say '  ntag send ada 10         you send $10 USDT, @ada gets naira'
  Say '  ntag help                everything else'
  Say ''
  Say 'Your wallet' White
  Say "  It lives in $WalletFile (separate from the app; update and uninstall never touch it)."
  Say '  Back it up after "ntag wallet new", and remember the send password. There is no recovery:'
  Say "    Copy-Item `"$WalletFile`" `"D:\backup\ntag-wallet.json`""
  Say ''
  Say 'Update: run the same one-liner again.' White
  Say "  $OneLine"
  Say 'Uninstall (keeps the wallet):' White
  Say "  `$env:NTAG_UNINSTALL = `"1`"; $OneLine"
  Say "  or by hand: delete $App and $Bin, and remove $Bin from your user PATH"
  Say '  (Settings > System > About > Advanced system settings > Environment Variables).'
  Say ''
  if (-not $NoPath) { Say 'Other terminals that were already open need to be restarted before "ntag" works there.' DarkGray; Say '' }
}
