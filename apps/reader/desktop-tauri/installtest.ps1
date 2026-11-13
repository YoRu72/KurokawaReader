# The Windows installer, end to end (stage R6b; .github/workflows/tauri-check-reader.yml, Windows only). Run from
# desktop-tauri/src-tauri after the build, the one-page step, the self-test and the engine test:
#   0. an ELECTRON KurokawaReader made to look installed (its folder, uninstall entry, data folder, desktop shortcut,
#      kurokawareader:// link), as electron-builder's per-user installer leaves it;
#   1. REAL screenshots of the installer's window (options closed, then open) and later of the first-run screen;
#   2. the installer run silently (/S): its time; files, uninstall entry, Start-menu shortcut, file types checked; the
#      Electron copy — its library NOT handed over (an IndexedDB folder, no hand-over) — KEPT beside it, untouched;
#      2b. a finished hand-over's marker put in its data folder and the installer run again (as the bridge build runs
#      it): the Electron copy's program removed, its data kept, its shortcut and link pointing at the new program;
#   3. the installed app started twice with KR_BOOTTIME (a cold start, then a warm one: first paint, app ready);
#   4. the installed app's self-test (KR_SELFTEST);
#   5. a second build with a higher version made, served as a fake release on 127.0.0.1 (updateserver.cjs: Range, the
#      first download cut off halfway), and installed over the first through the app's OWN updater (KR_UPDATETEST:
#      downloadUpdate → installDownloadedUpdate); the new version in place, a marker in the data folders kept;
#   6. uninstalled silently: the program gone, the data folders (and the library in them) kept.
# Pictures, logs and a summary go to $env:RUNNER_TEMP\kr-install (the workflow keeps it as an artifact), with the
# installer scripts Tauri rendered (nsis-<version>\installer.nsi, and installer.kr.nsi with the one screen in) and the
# install trace (install-trace.log: each install and uninstall step as installer/hooks.nsh notes it with
# KR_INSTALL_TRACE — which installer, the uninstall entry's DisplayVersion at that moment, its command line).
$ErrorActionPreference = 'Stop'
$d = Join-Path $env:RUNNER_TEMP 'kr-install'
New-Item -ItemType Directory -Force -Path $d | Out-Null
$trace = Join-Path $d 'install-trace.log'; $env:KR_INSTALL_TRACE = $trace
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
# The installer scripts Tauri rendered for this build (and the one-page one), kept for a person to read.
function SaveNsi($tag) {
  $to = Join-Path $d "nsis-$tag"; New-Item -ItemType Directory -Force -Path $to | Out-Null
  Get-ChildItem 'target' -Directory -Recurse -Depth 3 -Filter 'nsis' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\/]bundle[\\/]' } |
    ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter '*.nsi' -ErrorAction SilentlyContinue } | ForEach-Object { Copy-Item $_.FullName (Join-Path $to $_.Name) -Force }
}
# The update's installer and any uninstaller it runs (NSIS runs one from a copy in the temp folder: Un_*.exe, Au_.exe).
function Installers($instDir) {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*KurokawaReader-update*' -or $_.Name -like 'Un_*.exe' -or $_.Name -like 'Au_*.exe' -or $_.ExecutablePath -eq (Join-Path $instDir 'uninstall.exe')) })
}
function LnkTarget($p) { if (-not (Test-Path $p)) { return $null }; return (New-Object -ComObject WScript.Shell).CreateShortcut($p).TargetPath }
function MB($f) { '{0:N2} MB' -f ((Get-Item $f).Length / 1MB) }
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

$setup = Get-ChildItem 'target/release/bundle/nsis/*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'no NSIS installer built' }
$setup1 = Join-Path $d 'setup-1.exe'; Copy-Item $setup.FullName $setup1
$v1 = (node -p "require('../../package.json').version").Trim()
Row 'installer size' $true "$(MB $setup1) ($($setup.Name)); Electron's: 81.6 MB"
SaveNsi $v1

# 0. An Electron install, as electron-builder leaves one.
$old = Join-Path $env:LOCALAPPDATA 'Programs\KurokawaReader'
New-Item -ItemType Directory -Force -Path (Join-Path $old 'resources') | Out-Null
Set-Content (Join-Path $old 'resources\app.asar') 'asar'
Copy-Item (Join-Path $env:SystemRoot 'System32\where.exe') (Join-Path $old 'KurokawaReader.exe')
Set-Content (Join-Path $old 'Uninstall KurokawaReader.exe') 'x'
$ek = "$UninstKey\a1b2c3d4-kr-ci-electron"
New-Item $ek -Force | Out-Null
Set-ItemProperty $ek DisplayName 'KurokawaReader'; Set-ItemProperty $ek InstallLocation $old
Set-ItemProperty $ek UninstallString "`"$old\Uninstall KurokawaReader.exe`" /currentuser"
$edata = Join-Path $env:APPDATA 'KurokawaReader'; New-Item -ItemType Directory -Force -Path $edata | Out-Null
Set-Content (Join-Path $edata 'kr-ci-electron-data.txt') 'the Electron library'
# (A library in it — its IndexedDB folder — and no hand-over yet: the first install must KEEP the Electron copy.)
New-Item -ItemType Directory -Force -Path (Join-Path $edata 'IndexedDB\app_kurokawa_0.indexeddb.leveldb') | Out-Null
Remove-Item (Join-Path $edata 'handover') -Recurse -Force -ErrorAction SilentlyContinue
$desk = [Environment]::GetFolderPath('Desktop'); $deskLnk = Join-Path $desk 'KurokawaReader.lnk'
$l = (New-Object -ComObject WScript.Shell).CreateShortcut($deskLnk); $l.TargetPath = (Join-Path $old 'KurokawaReader.exe'); $l.Save()
New-Item 'HKCU:\Software\Classes\kurokawareader\shell\open\command' -Force | Out-Null
Set-Item 'HKCU:\Software\Classes\kurokawareader\shell\open\command' "`"$old\KurokawaReader.exe`" `"%1`""

# 1. The installer's window, for real (a person's first look): options closed, then open (/KROPTIONS).
foreach ($s in @(@('installer-real-1', @()), @('installer-real-2-options', @('/KROPTIONS')))) {
  $p = if ($s[1].Count) { Start-Process $setup1 -ArgumentList $s[1] -PassThru } else { Start-Process $setup1 -PassThru }
  Start-Sleep -Seconds 6; Shot $s[0]
  try { Stop-Process -Id $p.Id -Force } catch {}
  Start-Sleep -Seconds 1
}
Row 'installer window screenshots' (Test-Path (Join-Path $d 'installer-real-1.png')) 'installer-real-1.png, installer-real-2-options.png' $false

# 2. Installed silently.
$t = Measure-Command { $p = Start-Process $setup1 -ArgumentList '/S' -PassThru -Wait }
Row 'silent install' ($p.ExitCode -eq 0) ("{0:N1} s, exit {1}" -f $t.TotalSeconds, $p.ExitCode)
$e = Get-ItemProperty "$UninstKey\KurokawaReader" -ErrorAction SilentlyContinue
Row 'uninstall entry (HKCU, per user)' ($null -ne $e) ("$($e.DisplayName) $($e.DisplayVersion) — $($e.UninstallString)")
$un = ($e.UninstallString -replace '"', '').Trim(); $dir = Split-Path $un; $exe = Join-Path $dir 'KurokawaReader.exe'
Row 'files' ((Test-Path $exe) -and (Test-Path $un)) "$dir — $((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Count) files, $('{0:N1}' -f ((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) MB"
Row 'per user, no admin' ($dir -like "$env:LOCALAPPDATA*") $dir
Row '7-Zip shipped' ((Get-ChildItem $dir -Recurse -Filter '7za.exe' | Measure-Object).Count -gt 0) 'resources\7zip' $false
$start = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter 'KurokawaReader.lnk' | Where-Object { (LnkTarget $_.FullName) -eq $exe }
Row 'Start-menu shortcut' ($start.Count -gt 0) (($start | ForEach-Object { $_.FullName }) -join '; ')
$cls = (Get-ItemProperty 'HKCU:\Software\Classes\.epub' -ErrorAction SilentlyContinue).'(default)'
$cmd = if ($cls) { (Get-ItemProperty "HKCU:\Software\Classes\$cls\shell\open\command" -ErrorAction SilentlyContinue).'(default)' } else { '' }
Row '.epub opens with it' ($cmd -like "*$exe*") ".epub → $cls → $cmd"
# (0.62.0: its library not handed over → the Electron copy KEPT beside the new one, untouched.)
Row 'Electron copy kept (library not handed over)' ((Test-Path (Join-Path $old 'resources\app.asar')) -and (Test-Path (Join-Path $old 'KurokawaReader.exe')) -and (Test-Path $ek)) "$old; entry $(Test-Path $ek)"
Row 'Electron data kept' (Test-Path (Join-Path $edata 'kr-ci-electron-data.txt')) $edata
# 2b. The Electron «bridge» build's hand-over finished (its marker, written last, after every file was checked): the
# installer run again — as the bridge build runs it — now REPLACES the Electron copy.
New-Item -ItemType Directory -Force -Path (Join-Path $edata 'handover') | Out-Null
Set-Content (Join-Path $edata 'handover\marker.json') '{"app":"KurokawaReader","kind":"handover","format":1,"id":"ci","createdAt":0,"bytes":0,"files":[]}'
$t = Measure-Command { $p = Start-Process $setup1 -ArgumentList '/S' -PassThru -Wait }
Row 'install again after the hand-over' ($p.ExitCode -eq 0) ("{0:N1} s, exit {1}" -f $t.TotalSeconds, $p.ExitCode)
Row 'desktop shortcut → new program (was Electron''s)' ((LnkTarget $deskLnk) -eq $exe) (LnkTarget $deskLnk)
$link = (Get-ItemProperty 'HKCU:\Software\Classes\kurokawareader\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
Row 'kurokawareader:// → new program' ($link -like "*$exe*") $link
Row 'Electron program removed (hand-over found)' (-not (Test-Path (Join-Path $old 'resources\app.asar'))) $old
Row 'Electron uninstall entry removed' (-not (Test-Path $ek)) $ek
Row 'Electron data kept' (Test-Path (Join-Path $edata 'kr-ci-electron-data.txt')) $edata

# 3. Start-up: cold, then warm.
foreach ($n in @('cold', 'warm')) {
  $f = Join-Path $d "boot-$n.json"; $env:KR_BOOTTIME = $f
  $p = Start-Process $exe -PassThru
  if (-not $p.WaitForExit(60000)) { Stop-Process -Id $p.Id -Force }
  Remove-Item Env:KR_BOOTTIME
  $b = if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json } else { $null }
  Row "start-up ($n)" ($null -ne $b -and $null -ne $b.ready) $(if ($b) { $b.line } else { 'no times written' }) $false
}
# (The first-run screen, for real.)
$p = Start-Process $exe -PassThru; Start-Sleep -Seconds 8; Shot 'firstrun-real'; try { Stop-Process -Id $p.Id -Force } catch {}
Start-Sleep -Seconds 2

# 4. The installed app's own self-test.
$out = Join-Path $d 'selftest-installed.json'; $env:KR_SELFTEST = $out; $env:KR_SELFTEST_TIMEOUT = '330'
# (As the bare program's run: a file given on the command line, on another drive, must reach the page.)
$od = Join-Path $env:RUNNER_TEMP 'kr-open-installed'; New-Item -ItemType Directory -Force -Path $od | Out-Null
$of = Join-Path $od 'kr open-first.txt'; [System.IO.File]::WriteAllText($of, "Opened at start, from the command line.`n"); $env:KR_SELFTEST_OPEN = $of
$p = Start-Process $exe -ArgumentList ('"' + $of + '"') -PassThru; $null = $p.Handle
if ($p.WaitForExit(400000)) { $code = $p.ExitCode } else { Stop-Process -Id $p.Id -Force; $code = 124 }
Remove-Item Env:KR_SELFTEST, Env:KR_SELFTEST_OPEN
node ../selftest-report.cjs $out $code 'Windows (installed)' | Out-File (Join-Path $d 'selftest-installed.md')
Get-Content (Join-Path $d 'selftest-installed.md') | Write-Host
Row 'self-test of the installed app' ($code -eq 0) "exit $code"

# 5. A higher version through the app's own updater.
$parts = $v1.Split('-')[0].Split('.'); $v2 = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
Set-Content 'v2.conf.json' "{ `"version`": `"$v2`" }"
Push-Location ..
npx --yes @tauri-apps/cli@^2 build --bundles nsis --config src-tauri/v2.conf.json 2>&1 | Select-Object -Last 15 | Write-Host
node src-tauri/installer/onepage.cjs src-tauri --strict | Write-Host
Pop-Location
SaveNsi $v2
$setup2 = Get-ChildItem "target/release/bundle/nsis/*$v2*-setup.exe" | Select-Object -First 1
Row "second build ($v2)" ($null -ne $setup2) $(if ($setup2) { "$($setup2.Name), $(MB $setup2.FullName)" } else { 'not built' })
if ($setup2) {
  $feed = Join-Path $d 'feed'; New-Item -ItemType Directory -Force -Path $feed | Out-Null
  $name = "KurokawaReader-$v2-windows-x64-setup.exe"; Copy-Item $setup2.FullName (Join-Path $feed $name)
  $h = (Get-FileHash (Join-Path $feed $name) -Algorithm SHA256).Hash.ToLower()
  Set-Content (Join-Path $feed "KurokawaReader-$v2-SHA256SUMS.txt") "$h  $name" -NoNewline
  $portFile = Join-Path $d 'port.txt'
  $srv = Start-Process node -ArgumentList @('../updateserver.cjs', "`"$feed`"", "`"$portFile`"") -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 50 -and -not (Test-Path $portFile); $i++) { Start-Sleep -Milliseconds 200 }
  $port = (Get-Content $portFile -Raw).Trim()
  $cfgDir = Join-Path $env:APPDATA 'app.kurokawa.reader'; $locDir = Join-Path $env:LOCALAPPDATA 'app.kurokawa.reader'
  foreach ($m in @($cfgDir, $locDir)) { New-Item -ItemType Directory -Force -Path $m | Out-Null; Set-Content (Join-Path $m 'kr-ci-marker.txt') "kept since $v1" }
  $log = Join-Path $d 'updatetest.log'
  $env:KR_UPDATETEST = $log; $env:KR_UPDATE_FEED = "http://127.0.0.1:$port/releases"
  $t = Measure-Command { $p = Start-Process $exe -PassThru; $null = $p.Handle; if (-not $p.WaitForExit(240000)) { Stop-Process -Id $p.Id -Force } }
  Remove-Item Env:KR_UPDATETEST, Env:KR_UPDATE_FEED
  # The installer the app started (/P /R /UPDATE), and any uninstaller it runs, waited for until they end (150 s at
  # most); the screen pictured while it runs, and again if one is still there at the end (a question waiting shows).
  $sw = [Diagnostics.Stopwatch]::StartNew(); $seen = @(); $pictured = $false
  while ($sw.Elapsed.TotalSeconds -lt 150) {
    $ps = Installers $dir
    foreach ($q in $ps) { $line = "$($q.ProcessId) $($q.CommandLine)"; if ($seen -notcontains $line) { $seen += $line } }
    if ($ps.Count -and -not $pictured) { Start-Sleep -Milliseconds 400; Shot 'update-installer'; $pictured = $true }
    if (-not $ps.Count -and $sw.Elapsed.TotalSeconds -ge 4) { break }
    Start-Sleep -Milliseconds 250
  }
  $left = Installers $dir
  if ($left.Count) { Shot 'update-installer-stuck' }
  $waited = $sw.Elapsed.TotalSeconds
  $now = $null
  for ($i = 0; $i -lt 10; $i++) { $now = (Get-ItemProperty "$UninstKey\KurokawaReader" -ErrorAction SilentlyContinue).DisplayVersion; if ($now -eq $v2) { break }; Start-Sleep -Seconds 1 }
  $entry = Get-ItemProperty "$UninstKey\KurokawaReader" -ErrorAction SilentlyContinue
  $entryText = if ($entry) { ($entry.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; ' } else { 'the uninstall entry HKCU\...\Uninstall\KurokawaReader is gone' }
  # (Started again by the installer, /R: the new program running from the install folder.)
  $again = @(Get-CimInstance Win32_Process -Filter "Name='KurokawaReader.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $exe })
  Start-Sleep -Seconds 2
  Get-Process KurokawaReader -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Host '--- update test log'; Get-Content $log -ErrorAction SilentlyContinue | Write-Host
  Write-Host '--- server log'; Get-Content (Join-Path $feed 'server.log') -ErrorAction SilentlyContinue | Write-Host
  Write-Host '--- installers seen'; $seen | Write-Host
  Write-Host '--- install trace'; Get-Content $trace -ErrorAction SilentlyContinue | Write-Host
  Write-Host "--- uninstall entry: $entryText"
  Write-Host '--- program folder'; Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { '{0}  {1:N0} B  {2:u}  {3}' -f $_.FullName, $_.Length, $_.LastWriteTime, $_.VersionInfo.ProductVersion } | Write-Host
  $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
  Row 'update downloaded (resumed) and checked' ($text -match 'download downloaded') (($text -split "`n" | Where-Object { $_ -match '^download|^install|^FAIL' }) -join ' / ')
  Row 'resumed after a cut' ((Get-Content (Join-Path $feed 'server.log') -Raw) -match 'range \d+-') 'server.log: a Range request after the cut'
  Row "the update's installer ended by itself" ($left.Count -eq 0) ("{0:N0} s after the app left; {1} process(es) seen: {2}{3}" -f $waited, $seen.Count, (($seen | ForEach-Object { ($_ -replace '^\d+ ', '') -replace '^"?([^"]*\\)?([^"\\]+\.exe)"?', '$2' }) -join ' + '), $(if ($left.Count) { '; STILL RUNNING (update-installer-stuck.png): ' + (($left | ForEach-Object { $_.CommandLine }) -join ' + ') } else { '' }))
  Row "installed version $v1 → $v2 (the app's own updater)" ($now -eq $v2) ("{0} — {1}" -f $(if ($now) { $now } else { 'none' }), $entryText)
  Row 'install trace (installer/hooks.nsh)' (Test-Path $trace) $(if (Test-Path $trace) { ((Get-Content $trace) | ForEach-Object { ($_ -split ' tick=')[0] }) -join ' → ' } else { 'not written' }) $false
  Row 'started again after the update (/R)' ($again.Count -gt 0) $(if ($again.Count) { "$exe, $(($again | ForEach-Object { $_.CreationDate }) -join ', ')" } else { 'not running after the installer ended' }) $false
  Row 'program version' ((Get-Item $exe).VersionInfo.ProductVersion -like "$v2*") ((Get-Item $exe).VersionInfo.ProductVersion) $false
  Row 'data kept over the update' ((Test-Path (Join-Path $cfgDir 'kr-ci-marker.txt')) -and (Test-Path (Join-Path $locDir 'kr-ci-marker.txt'))) "$cfgDir, $locDir"
  Row 'desktop shortcut kept' ((LnkTarget $deskLnk) -eq $exe) (LnkTarget $deskLnk)
  try { Stop-Process -Id $srv.Id -Force } catch {}
}

# 6. Uninstalled silently: program gone, data kept.
if (Test-Path $un) {
  Start-Process $un -ArgumentList '/S' -Wait
  for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
  Row 'uninstalled' (-not (Test-Path $exe) -and -not (Test-Path "$UninstKey\KurokawaReader")) $dir
} else { Row 'uninstalled' $false "no uninstaller at $un" }
Row 'library (data folders) kept after uninstall' ((Test-Path (Join-Path $env:APPDATA 'app.kurokawa.reader\kr-ci-marker.txt')) -and (Test-Path (Join-Path $env:LOCALAPPDATA 'app.kurokawa.reader'))) 'app.kurokawa.reader in Roaming and Local'
Row 'Electron data still kept' (Test-Path (Join-Path $edata 'kr-ci-electron-data.txt')) $edata

$summary = @('### Windows — the installer, end to end (R6b)', '', '| Check | | Detail |', '|---|---|---|') + $rows + @('', "Pictures and logs: artifact tauri-reader-install-windows. Failures: $($fails.Count)")
$summary -join "`n" | Out-File -Append -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8
$summary -join "`n" | Out-File -FilePath (Join-Path $d 'summary.md') -Encoding utf8
if ($fails.Count) { Write-Host "FAILED: $($fails -join ', ')"; exit 1 }
