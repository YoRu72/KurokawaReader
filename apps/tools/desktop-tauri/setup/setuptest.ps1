# Kurokawa Tools Setup — the designed setup program, end to end on Windows (Tools' stage P9: the Reader's
# setup/setuptest.ps1 with Tools' names; .github/workflows/tauri-check.yml runs it after installtest.ps1, which leaves the app uninstalled). Run from
# desktop-tauri/src-tauri. Uses the program built by the «Setup program» step:
#   target/release/bundle/setup/KurokawaTools-<v>-windows-x64.exe  (R6b's NSIS installer embedded)
#   0. its size beside the plain installer's;
#   1. REAL screenshots of its window — welcome, then with the options open (--options) — and how soon it showed;
#   2. installed through the window (--auto --no-desktop: «Install» pressed with the desktop shortcut off): the time
#      to «done», screenshots while installing and when done; the files, the uninstall entry, the Start-menu shortcut,
#      NO desktop shortcut (/KRDESK=0 — onepage.nsh's addition), .torrent opening with it;
#   3. run again over it (--auto --no-assoc): an update in place — «Update» on the window, the desktop shortcut made,
#      .torrent NOT opening with it (/KRASSOC=0);
#   4. passed straight through (/S, as the app's updater and unattended installs run it): exit 0, the kinds of file
#      back;
#   5. uninstalled silently;
#   6. (0.62.0) an installed Electron copy with a library and no hand-over KEPT beside it (/KROLD=keep), then — its
#      hand-over's marker there — replaced (/KROLD=replace); its data folder kept.
# Pictures and a summary go to $env:RUNNER_TEMP\kr-install (the workflow's install artifact), with the install trace
# (setup-trace.log: installer/hooks.nsh's KR_TRACE lines for every install and uninstall the program runs).
$ErrorActionPreference = 'Stop'
# (The program's file name is Tauri's to choose: the workflow reads it from the installer script's MAINBINARYNAME.)
$exeName = if ($env:KT_APP_EXE) { $env:KT_APP_EXE } else { 'Kurokawa Tools.exe' }
$procName = [IO.Path]::GetFileNameWithoutExtension($exeName)
$d = Join-Path $env:RUNNER_TEMP 'kr-install'
New-Item -ItemType Directory -Force -Path $d | Out-Null
$trace = Join-Path $d 'setup-trace.log'; $env:KR_INSTALL_TRACE = $trace
$fails = New-Object System.Collections.ArrayList
$rows = New-Object System.Collections.ArrayList
function Row($name, $ok, $detail, $required = $true) {
  $mark = if ($ok) { 'ok' } elseif ($required) { 'FAIL' } else { 'not ok (reported)' }
  [void]$rows.Add("| $name | $mark | $($detail -replace '\|', '/') |")
  Write-Host "$mark  $name — $detail"
  if (-not $ok -and $required) { [void]$fails.Add($name) }
}
function Shot($name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $d "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  } catch { Write-Host "screenshot $name failed: $_" }
}
# The embedded installer (written out to %TEMP%\KurokawaTools-setup-<pid>\) and any uninstaller NSIS runs from a copy
# in the temp folder (Un_*.exe, Au_*.exe), waited for until they have ended (60 s at most): the next step must not
# start while one still runs.
function Wait-Installers($instDir) {
  for ($i = 0; $i -lt 240; $i++) {
    $ps = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*\KurokawaTools-setup-*' -or $_.Name -like 'Un_*.exe' -or $_.Name -like 'Au_*.exe' -or $_.ExecutablePath -eq (Join-Path $instDir 'uninstall.exe')) })
    if (-not $ps.Count) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}
# The uninstaller run silently and waited for (it starts a copy of itself from the temp folder and returns at once).
function Uninstall-Silently($un, $instDir) {
  if (-not (Test-Path $un)) { return }
  Start-Process $un -ArgumentList '/S' -Wait
  for ($i = 0; $i -lt 60 -and (Test-Path (Join-Path $instDir $exeName)); $i++) { Start-Sleep -Seconds 1 }
  $null = Wait-Installers $instDir
}
function MB($f) { '{0:N2} MB' -f ((Get-Item $f).Length / 1MB) }
function Stop-Setup($p) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch {}; Start-Sleep -Milliseconds 500 }
function Epub-Opens-With-Us($exe) {
  $cls = (Get-ItemProperty 'HKCU:\Software\Classes\.torrent' -ErrorAction SilentlyContinue).'(default)'
  $cmd = if ($cls) { (Get-ItemProperty "HKCU:\Software\Classes\$cls\shell\open\command" -ErrorAction SilentlyContinue).'(default)' } else { '' }
  return ($cmd -like "*$exe*")
}
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$desk = [Environment]::GetFolderPath('Desktop'); $deskLnk = Join-Path $desk 'Kurokawa Tools.lnk'
$dir = Join-Path $env:LOCALAPPDATA 'Kurokawa Tools'; $exe = Join-Path $dir $exeName

$setup = Get-ChildItem 'target/release/bundle/setup/*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'no setup program built (target/release/bundle/setup)' }
$s = Join-Path $d 'kr-setup.exe'; Copy-Item $setup.FullName $s
$plain = Get-ChildItem 'target/release/bundle/nsis/*-setup.exe' | Sort-Object Length | Select-Object -First 1
Row 'setup program size' $true "$(MB $s) ($($setup.Name)); the plain installer: $(if ($plain) { MB $plain.FullName } else { '?' })"

# (A clean start: no copy, no shortcut.)
$e0 = Get-ItemProperty "$UninstKey\Kurokawa Tools" -ErrorAction SilentlyContinue
if ($e0) { $un0 = ($e0.UninstallString -replace '"', '').Trim(); Uninstall-Silently $un0 (Split-Path $un0) }
Remove-Item $deskLnk -ErrorAction SilentlyContinue

# 1. Its window, for real: how soon it is there, welcome, then the options open.
$t0 = Get-Date
$p = Start-Process $s -PassThru
$shown = $null
for ($i = 0; $i -lt 100; $i++) { $p.Refresh(); if ($p.MainWindowHandle -ne 0) { $shown = ((Get-Date) - $t0).TotalMilliseconds; break }; Start-Sleep -Milliseconds 50 }
Row 'window shown' ($null -ne $shown) $(if ($null -ne $shown) { "{0:N0} ms after start ($($p.MainWindowTitle))" -f $shown } else { 'no window in 5 s' })
Start-Sleep -Seconds 3; Shot 'setup-real-1-welcome'; Stop-Setup $p
$p = Start-Process $s -ArgumentList '--options' -PassThru; Start-Sleep -Seconds 4; Shot 'setup-real-2-options'; Stop-Setup $p
Row 'setup window screenshots' (Test-Path (Join-Path $d 'setup-real-1-welcome.png')) 'setup-real-1-welcome.png, setup-real-2-options.png' $false

# 2. Installed through the window: desktop shortcut off.
$t0 = Get-Date
$p = Start-Process $s -ArgumentList @('--auto', '--no-desktop') -PassThru
$mid = $false; $done = $null
for ($i = 0; $i -lt 600; $i++) {
  $el = ((Get-Date) - $t0).TotalMilliseconds
  if (-not $mid -and $el -gt 1300) { Shot 'setup-real-3-installing'; $mid = $true }
  $v = (Get-ItemProperty "$UninstKey\Kurokawa Tools" -ErrorAction SilentlyContinue).DisplayVersion
  if ($v -and (Test-Path $exe) -and (Test-Path (Join-Path $dir 'uninstall.exe')) -and ($el -gt 1500)) {
    # (The installer's own process gone: the install has ended.)
    $inner = Get-Process | Where-Object { $_.Path -like "*KurokawaTools-setup-*" } -ErrorAction SilentlyContinue
    if (-not $inner) { $done = $el; break }
  }
  Start-Sleep -Milliseconds 100
}
Start-Sleep -Milliseconds 900; Shot 'setup-real-4-done'
Row 'install through the window' ($null -ne $done) $(if ($done) { "{0:N1} s from start to installed (window included)" -f ($done / 1000) } else { 'not installed in 60 s' })
Row 'files and uninstall entry' ((Test-Path $exe) -and $null -ne (Get-ItemProperty "$UninstKey\Kurokawa Tools" -ErrorAction SilentlyContinue)) $dir
Row 'still running (shows «done», not closed: --auto keeps the app closed)' (-not $p.HasExited) "pid $($p.Id)" $false
Row 'no desktop shortcut (chosen off: /KRDESK=0)' (-not (Test-Path $deskLnk)) $deskLnk
Row '.torrent opens with it (chosen on)' (Epub-Opens-With-Us $exe) '.torrent'
$start = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter 'Kurokawa Tools.lnk' -ErrorAction SilentlyContinue
Row 'Start-menu shortcut' ($start.Count -gt 0) (($start | ForEach-Object { $_.FullName }) -join '; ')
Row 'the app not opened (open when done off)' (-not (Get-Process -Name $procName -ErrorAction SilentlyContinue)) '' $false
$null = Wait-Installers $dir
Stop-Setup $p
Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Again, over it: an update in place; desktop shortcut on, the kinds of file off.
$p = Start-Process $s -ArgumentList @('--auto', '--no-assoc') -PassThru
Start-Sleep -Milliseconds 500; Shot 'setup-real-5-update'
for ($i = 0; $i -lt 300 -and -not (Test-Path $deskLnk); $i++) { Start-Sleep -Milliseconds 100 }
Start-Sleep -Seconds 1
Row 'over it: the installer ended' (Wait-Installers $dir) 'the embedded installer and any uninstaller it ran'
Row 'over an installed copy: desktop shortcut made (/KRDESK=1)' (Test-Path $deskLnk) $deskLnk
Row '.torrent no longer opens with it (/KRASSOC=0)' (-not (Epub-Opens-With-Us $exe)) '.torrent'
$e3 = Get-ItemProperty "$UninstKey\Kurokawa Tools" -ErrorAction SilentlyContinue
Row 'over it: the uninstall entry kept' ($null -ne $e3 -and $e3.DisplayVersion) $(if ($e3) { "$($e3.DisplayName) $($e3.DisplayVersion) — $($e3.UninstallString)" } else { 'HKCU\...\Uninstall\Kurokawa Tools is gone' })
Stop-Setup $p

# 4. Straight through: /S.
$t = Measure-Command { $p = Start-Process $s -ArgumentList '/S' -PassThru -Wait }
Row 'passed through (/S)' ($p.ExitCode -eq 0) ("{0:N1} s, exit {1}" -f $t.TotalSeconds, $p.ExitCode)
Row '.torrent opens with it again (silent: Tauri''s own)' (Epub-Opens-With-Us $exe) '.torrent'
Row 'temporary folder removed' (-not (Get-ChildItem $env:TEMP -Directory -Filter 'KurokawaTools-setup-*' -ErrorAction SilentlyContinue)) $env:TEMP $false

# 5. Uninstalled.
$un = Join-Path $dir 'uninstall.exe'
Uninstall-Silently $un $dir
Row 'uninstalled' (-not (Test-Path $exe) -and -not (Test-Path "$UninstKey\Kurokawa Tools")) $dir
# 6. (0.62.0) An installed ELECTRON Kurokawa Tools with a library and NO hand-over: kept beside the new one (the
# setup program passes /KROLD=keep); then its hand-over's marker there (the bridge build finished it): replaced
# (/KROLD=replace). Its data folder is never touched.
$old = Join-Path $env:LOCALAPPDATA 'Programs\Kurokawa Tools'
New-Item -ItemType Directory -Force -Path (Join-Path $old 'resources') | Out-Null
Set-Content (Join-Path $old 'resources\app.asar') 'asar'
Copy-Item (Join-Path $env:SystemRoot 'System32\where.exe') (Join-Path $old 'Kurokawa Tools.exe')
$ek = "$UninstKey\a1b2c3d4-kr-ci-electron-setup"
New-Item $ek -Force | Out-Null; Set-ItemProperty $ek DisplayName 'Kurokawa Tools'; Set-ItemProperty $ek InstallLocation $old
$edata = Join-Path $env:APPDATA 'Kurokawa Tools'
New-Item -ItemType Directory -Force -Path (Join-Path $edata 'IndexedDB\app_kurokawa_0.indexeddb.leveldb') | Out-Null
Remove-Item (Join-Path $edata 'handover') -Recurse -Force -ErrorAction SilentlyContinue
function Install-Auto($tag) {
  $p = Start-Process $s -ArgumentList @('--auto', '--no-desktop') -PassThru
  for ($i = 0; $i -lt 600; $i++) {
    $v = (Get-ItemProperty "$UninstKey\Kurokawa Tools" -ErrorAction SilentlyContinue).DisplayVersion
    if ($v -and (Test-Path $exe) -and $i -gt 15) { if (-not (Get-Process | Where-Object { $_.Path -like "*KurokawaTools-setup-*" } -ErrorAction SilentlyContinue)) { break } }
    Start-Sleep -Milliseconds 100
  }
  Start-Sleep -Milliseconds 900; Shot $tag
  $null = Wait-Installers $dir; Stop-Setup $p
}
Install-Auto 'setup-real-6-electron-kept'
Row 'Electron with a library, no hand-over: kept beside it' ((Test-Path (Join-Path $old 'resources\app.asar')) -and (Test-Path $ek)) $old
Row '… the setup program passed /KROLD=keep' ((Test-Path $trace) -and ((Get-Content $trace -Raw) -match '/KROLD=keep')) 'setup-trace.log'
New-Item -ItemType Directory -Force -Path (Join-Path $edata 'handover') | Out-Null
Set-Content (Join-Path $edata 'handover\marker.json') '{"app":"KurokawaTools","kind":"handover","format":1,"id":"ci-setup","createdAt":0,"bytes":0,"files":[]}'
Install-Auto 'setup-real-7-electron-replaced'
Row 'its hand-over finished: replaced' (-not (Test-Path (Join-Path $old 'resources\app.asar')) -and -not (Test-Path $ek)) $old
Row '… /KROLD=replace passed' ((Get-Content $trace -Raw) -match '/KROLD=replace') 'setup-trace.log'
Row '… its data folder kept' (Test-Path (Join-Path $edata 'IndexedDB')) $edata
Uninstall-Silently (Join-Path $dir 'uninstall.exe') $dir
Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item $ek -Force -ErrorAction SilentlyContinue

Row 'install trace (installer/hooks.nsh)' (Test-Path $trace) $(if (Test-Path $trace) { ((Get-Content $trace) | ForEach-Object { ($_ -split ' tick=')[0] }) -join ' → ' } else { 'not written' }) $false
Remove-Item Env:KR_INSTALL_TRACE

$md = @('### Windows — the designed setup program (setup/setuptest.ps1)', '', '| Check | Result | Detail |', '|---|---|---|') + $rows
$md -join "`n" | Out-File (Join-Path $d 'setuptest.md') -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) { $md -join "`n" | Out-File $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8 }
if ($fails.Count) { Write-Host "FAILED: $($fails -join ', ')"; exit 1 }
exit 0
