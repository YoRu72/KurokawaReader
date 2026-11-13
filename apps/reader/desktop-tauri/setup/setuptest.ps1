# KurokawaReader Setup — the designed setup program, end to end on Windows (setup/INTEGRATION.md puts it in
# .github/workflows/tauri-check-reader.yml after installtest.ps1, which leaves the app uninstalled). Run from
# desktop-tauri/src-tauri. Uses the program built by the «Setup program» step:
#   target/release/bundle/setup/KurokawaReader-<v>-windows-x64.exe  (R6b's NSIS installer embedded)
#   0. its size beside the plain installer's;
#   1. REAL screenshots of its window — welcome, then with the options open (--options) — and how soon it showed;
#   2. installed through the window (--auto --no-desktop: «Install» pressed with the desktop shortcut off): the time
#      to «done», screenshots while installing and when done; the files, the uninstall entry, the Start-menu shortcut,
#      NO desktop shortcut (/KRDESK=0 — onepage.nsh's addition), .epub opening with it;
#   3. run again over it (--auto --no-assoc): an update in place — «Update» on the window, the desktop shortcut made,
#      .epub NOT opening with it (/KRASSOC=0);
#   4. passed straight through (/S, as the app's updater and unattended installs run it): exit 0, the kinds of file
#      back;
#   5. uninstalled silently.
# Pictures and a summary go to $env:RUNNER_TEMP\kr-install (the workflow's install artifact).
$ErrorActionPreference = 'Stop'
$d = Join-Path $env:RUNNER_TEMP 'kr-install'
New-Item -ItemType Directory -Force -Path $d | Out-Null
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
function MB($f) { '{0:N2} MB' -f ((Get-Item $f).Length / 1MB) }
function Stop-Setup($p) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch {}; Start-Sleep -Milliseconds 500 }
function Epub-Opens-With-Us($exe) {
  $cls = (Get-ItemProperty 'HKCU:\Software\Classes\.epub' -ErrorAction SilentlyContinue).'(default)'
  $cmd = if ($cls) { (Get-ItemProperty "HKCU:\Software\Classes\$cls\shell\open\command" -ErrorAction SilentlyContinue).'(default)' } else { '' }
  return ($cmd -like "*$exe*")
}
$UN = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$desk = [Environment]::GetFolderPath('Desktop'); $deskLnk = Join-Path $desk 'KurokawaReader.lnk'
$dir = Join-Path $env:LOCALAPPDATA 'KurokawaReader'; $exe = Join-Path $dir 'KurokawaReader.exe'

$setup = Get-ChildItem 'target/release/bundle/setup/*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'no setup program built (target/release/bundle/setup)' }
$s = Join-Path $d 'kr-setup.exe'; Copy-Item $setup.FullName $s
$plain = Get-ChildItem 'target/release/bundle/nsis/*-setup.exe' | Sort-Object Length | Select-Object -First 1
Row 'setup program size' $true "$(MB $s) ($($setup.Name)); the plain installer: $(if ($plain) { MB $plain.FullName } else { '?' })"

# (A clean start: no copy, no shortcut.)
$e0 = Get-ItemProperty "$UN\KurokawaReader" -ErrorAction SilentlyContinue
if ($e0) { $un0 = ($e0.UninstallString -replace '"', '').Trim(); if (Test-Path $un0) { Start-Process $un0 -ArgumentList '/S' -Wait } ; Start-Sleep -Seconds 2 }
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
  $v = (Get-ItemProperty "$UN\KurokawaReader" -ErrorAction SilentlyContinue).DisplayVersion
  if ($v -and (Test-Path $exe) -and (Test-Path (Join-Path $dir 'uninstall.exe')) -and ($el -gt 1500)) {
    # (The installer's own process gone: the install has ended.)
    $inner = Get-Process | Where-Object { $_.Path -like "*KurokawaReader-setup-*" } -ErrorAction SilentlyContinue
    if (-not $inner) { $done = $el; break }
  }
  Start-Sleep -Milliseconds 100
}
Start-Sleep -Milliseconds 900; Shot 'setup-real-4-done'
Row 'install through the window' ($null -ne $done) $(if ($done) { "{0:N1} s from start to installed (window included)" -f ($done / 1000) } else { 'not installed in 60 s' })
Row 'files and uninstall entry' ((Test-Path $exe) -and $null -ne (Get-ItemProperty "$UN\KurokawaReader" -ErrorAction SilentlyContinue)) $dir
Row 'still running (shows «done», not closed: --auto keeps the app closed)' (-not $p.HasExited) "pid $($p.Id)" $false
Row 'no desktop shortcut (chosen off: /KRDESK=0)' (-not (Test-Path $deskLnk)) $deskLnk
Row '.epub opens with it (chosen on)' (Epub-Opens-With-Us $exe) '.epub'
$start = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter 'KurokawaReader.lnk' -ErrorAction SilentlyContinue
Row 'Start-menu shortcut' ($start.Count -gt 0) (($start | ForEach-Object { $_.FullName }) -join '; ')
Row 'the app not opened (open when done off)' (-not (Get-Process KurokawaReader -ErrorAction SilentlyContinue)) '' $false
Stop-Setup $p
Get-Process KurokawaReader -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Again, over it: an update in place; desktop shortcut on, the kinds of file off.
$p = Start-Process $s -ArgumentList @('--auto', '--no-assoc') -PassThru
Start-Sleep -Milliseconds 500; Shot 'setup-real-5-update'
for ($i = 0; $i -lt 300 -and -not (Test-Path $deskLnk); $i++) { Start-Sleep -Milliseconds 100 }
Start-Sleep -Seconds 2
Row 'over an installed copy: desktop shortcut made (/KRDESK=1)' (Test-Path $deskLnk) $deskLnk
Row '.epub no longer opens with it (/KRASSOC=0)' (-not (Epub-Opens-With-Us $exe)) '.epub'
Stop-Setup $p

# 4. Straight through: /S.
$t = Measure-Command { $p = Start-Process $s -ArgumentList '/S' -PassThru -Wait }
Row 'passed through (/S)' ($p.ExitCode -eq 0) ("{0:N1} s, exit {1}" -f $t.TotalSeconds, $p.ExitCode)
Row '.epub opens with it again (silent: Tauri''s own)' (Epub-Opens-With-Us $exe) '.epub'
Row 'temporary folder removed' (-not (Get-ChildItem $env:TEMP -Directory -Filter 'KurokawaReader-setup-*' -ErrorAction SilentlyContinue)) $env:TEMP $false

# 5. Uninstalled.
$un = Join-Path $dir 'uninstall.exe'
if (Test-Path $un) { Start-Process $un -ArgumentList '/S' -Wait; Start-Sleep -Seconds 3 }
Row 'uninstalled' (-not (Test-Path $exe)) $dir

$md = @('### Windows — the designed setup program (setup/setuptest.ps1)', '', '| Check | Result | Detail |', '|---|---|---|') + $rows
$md -join "`n" | Out-File (Join-Path $d 'setuptest.md') -Encoding utf8
if ($env:GITHUB_STEP_SUMMARY) { $md -join "`n" | Out-File $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8 }
if ($fails.Count) { Write-Host "FAILED: $($fails -join ', ')"; exit 1 }
exit 0
