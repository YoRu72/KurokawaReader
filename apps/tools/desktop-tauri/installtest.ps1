# The Windows installer, end to end (Tools' stage P9; the Reader's desktop-tauri/installtest.ps1, stage R6b, with Tools'
# names, data and links; .github/workflows/tauri-check.yml, Windows only). Run from desktop-tauri/src-tauri after the
# build, the one-page step and the self-test:
#   0. an ELECTRON Kurokawa Tools made to look installed (its folder, uninstall entry, data folder with web storage, a
#      desktop shortcut, its magnet: and kurokawatools:// links and its .torrent kind), as electron-builder's per-user
#      installer leaves it;
#   1. REAL screenshots of the installer's window (options closed, then open) and later of the first-run screen;
#   2. the installer run silently (/S): its time; files, uninstall entry, Start-menu shortcut checked; the Electron copy
#      — its data NOT handed over — KEPT beside it, untouched, and its links and .torrent kind put back as they were;
#      2b. a finished hand-over's marker put in its data folder and the installer run again (as the bridge build runs
#      it): the Electron copy's program removed, its data kept, its shortcut, links and .torrent pointing at the new
#      program;
#   3. the installed app's self-test (KT_SELFTEST, both parts);
#   4. a second build with a higher version installed over the first as the app's updater runs it (/P /R /UPDATE): the
#      new version in place, the uninstall entry kept, a marker in the data folders kept, the desktop shortcut kept;
#   5. uninstalled silently: the program gone, the data folders kept.
# Pictures, logs and a summary go to $env:RUNNER_TEMP\kr-install (the workflow keeps it as an artifact), with the
# installer scripts Tauri rendered and the install trace (install-trace.log: installer/hooks.nsh's KR_TRACE lines).
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
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*KurokawaTools-update*' -or $_.Name -like 'Un_*.exe' -or $_.Name -like 'Au_*.exe' -or $_.ExecutablePath -eq (Join-Path $instDir 'uninstall.exe')) })
}
function LnkTarget($p) { if (-not (Test-Path $p)) { return $null }; return (New-Object -ComObject WScript.Shell).CreateShortcut($p).TargetPath }
function MB($f) { '{0:N2} MB' -f ((Get-Item $f).Length / 1MB) }
function Opens-With($kindOrScheme, $exe) {
  if ($kindOrScheme -like '.*') { $cls = (Get-ItemProperty "HKCU:\Software\Classes\$kindOrScheme" -ErrorAction SilentlyContinue).'(default)'; $key = if ($cls) { "HKCU:\Software\Classes\$cls\shell\open\command" } else { '' } }
  else { $key = "HKCU:\Software\Classes\$kindOrScheme\shell\open\command" }
  $cmd = if ($key) { (Get-ItemProperty $key -ErrorAction SilentlyContinue).'(default)' } else { '' }
  return @(($cmd -like "*$exe*"), "$kindOrScheme → $cmd")
}
$UninstKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$Product = 'Kurokawa Tools'

$setup = Get-ChildItem 'target/release/bundle/nsis/*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'no NSIS installer built' }
$setup1 = Join-Path $d 'setup-1.exe'; Copy-Item $setup.FullName $setup1
$v1 = (node -p "require('../../package.json').version").Trim()
Row 'installer size' $true "$(MB $setup1) ($($setup.Name)); Electron's: 84 MB"
SaveNsi $v1

# 0. An Electron install, as electron-builder leaves one.
$old = Join-Path $env:LOCALAPPDATA "Programs\$Product"; $oldExe = Join-Path $old "$Product.exe"
New-Item -ItemType Directory -Force -Path (Join-Path $old 'resources') | Out-Null
Set-Content (Join-Path $old 'resources\app.asar') 'asar'
Copy-Item (Join-Path $env:SystemRoot 'System32\where.exe') $oldExe
Set-Content (Join-Path $old "Uninstall $Product.exe") 'x'
$ek = "$UninstKey\a1b2c3d4-kt-ci-electron"
New-Item $ek -Force | Out-Null
Set-ItemProperty $ek DisplayName $Product; Set-ItemProperty $ek InstallLocation $old
Set-ItemProperty $ek UninstallString "`"$old\Uninstall $Product.exe`" /currentuser"
$edata = Join-Path $env:APPDATA $Product; New-Item -ItemType Directory -Force -Path $edata | Out-Null
Set-Content (Join-Path $edata 'kt-ci-electron-data.txt') 'the Electron data'
# (Its settings and lists — its web storage — and no hand-over yet: the first install must KEEP the Electron copy.)
New-Item -ItemType Directory -Force -Path (Join-Path $edata 'Local Storage\leveldb') | Out-Null
Set-Content (Join-Path $edata 'aria2.session') "https://example.test/a.bin`n gid=00a1b2c3d4e5f601`n"
Remove-Item (Join-Path $edata 'handover') -Recurse -Force -ErrorAction SilentlyContinue
$desk = [Environment]::GetFolderPath('Desktop'); $deskLnk = Join-Path $desk "$Product.lnk"
$l = (New-Object -ComObject WScript.Shell).CreateShortcut($deskLnk); $l.TargetPath = $oldExe; $l.Save()
foreach ($s in 'magnet', 'kurokawatools') { New-Item "HKCU:\Software\Classes\$s\shell\open\command" -Force | Out-Null; Set-Item "HKCU:\Software\Classes\$s\shell\open\command" "`"$oldExe`" `"%1`""; Set-ItemProperty "HKCU:\Software\Classes\$s" 'URL Protocol' '' }
# (Its .torrent kind under a class name of its own, as electron-builder may name it.)
New-Item 'HKCU:\Software\Classes\.torrent' -Force | Out-Null; Set-Item 'HKCU:\Software\Classes\.torrent' 'KurokawaToolsElectron.torrent'
New-Item 'HKCU:\Software\Classes\KurokawaToolsElectron.torrent\shell\open\command' -Force | Out-Null; Set-Item 'HKCU:\Software\Classes\KurokawaToolsElectron.torrent\shell\open\command' "`"$oldExe`" `"%1`""
# (It starts with the computer, as Electron's setLoginItemSettings leaves it: a Run value named by its AppUserModelId.)
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Set-ItemProperty $runKey 'app.kurokawa.tools' "`"$oldExe`" --hidden"
Remove-ItemProperty $runKey 'Kurokawa Tools' -ErrorAction SilentlyContinue
$partial = Join-Path $env:RUNNER_TEMP 'kt-ci-downloads\a.bin'; New-Item -ItemType Directory -Force -Path (Split-Path $partial) | Out-Null
[IO.File]::WriteAllBytes($partial, [byte[]](1..200)); [IO.File]::WriteAllBytes("$partial.aria2", [byte[]](1..50))
$partialSum = (Get-FileHash $partial).Hash + (Get-FileHash "$partial.aria2").Hash

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
$e = Get-ItemProperty "$UninstKey\$Product" -ErrorAction SilentlyContinue
Row 'uninstall entry (HKCU, per user)' ($null -ne $e) ("$($e.DisplayName) $($e.DisplayVersion) — $($e.UninstallString)")
$un = ($e.UninstallString -replace '"', '').Trim(); $dir = Split-Path $un
# (The program's file name is Tauri's: the one .exe in the folder that is not the uninstaller.)
$exeItem = Get-ChildItem $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'uninstall.exe' } | Select-Object -First 1
$exe = if ($exeItem) { $exeItem.FullName } else { Join-Path $dir "$Product.exe" }
$procName = [IO.Path]::GetFileNameWithoutExtension($exe)
Row 'files' ((Test-Path $exe) -and (Test-Path $un)) "$exe — $((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Count) files, $('{0:N1}' -f ((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) MB"
Row 'per user, no admin' ($dir -like "$env:LOCALAPPDATA*") $dir
Row 'aria2c and 7-Zip shipped' (((Get-ChildItem $dir -Recurse -Filter 'aria2c.exe' | Measure-Object).Count -gt 0) -and ((Get-ChildItem $dir -Recurse -Filter '7za.exe' | Measure-Object).Count -gt 0)) 'resources\aria2, resources\7zip' $false
$start = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter "$Product.lnk" | Where-Object { (LnkTarget $_.FullName) -eq $exe }
Row 'Start-menu shortcut' ($start.Count -gt 0) (($start | ForEach-Object { $_.FullName }) -join '; ')
# (Its data not handed over → the Electron copy KEPT beside the new one, untouched — and its links and .torrent its own.)
Row 'Electron copy kept (data not handed over)' ((Test-Path (Join-Path $old 'resources\app.asar')) -and (Test-Path $oldExe) -and (Test-Path $ek)) "$old; entry $(Test-Path $ek)"
foreach ($k in '.torrent', 'magnet', 'kurokawatools') { $r = Opens-With $k $oldExe; Row "kept: $k still opens the Electron program" $r[0] $r[1] }
Row 'desktop shortcut still the Electron program''s' ((LnkTarget $deskLnk) -eq $oldExe) (LnkTarget $deskLnk)
Row 'Electron data kept' ((Test-Path (Join-Path $edata 'kt-ci-electron-data.txt')) -and (Test-Path (Join-Path $edata 'aria2.session'))) $edata
$runOld = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).'app.kurokawa.tools'; $runNew = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).'Kurokawa Tools'
Row 'kept: its start at log-in left as it was, no second added' (($runOld -like "*$oldExe*") -and -not $runNew) "old [$runOld], new [$runNew]"
# 2b. The Electron «bridge» build's hand-over finished (its marker, written last, after every file was checked): the
# installer run again — as the bridge build runs it — now REPLACES the Electron copy.
New-Item -ItemType Directory -Force -Path (Join-Path $edata 'handover') | Out-Null
Set-Content (Join-Path $edata 'handover\marker.json') '{"app":"KurokawaTools","kind":"handover","format":1,"id":"ci","createdAt":0,"bytes":0,"files":[]}'
$t = Measure-Command { $p = Start-Process $setup1 -ArgumentList '/S' -PassThru -Wait }
Row 'install again after the hand-over' ($p.ExitCode -eq 0) ("{0:N1} s, exit {1}" -f $t.TotalSeconds, $p.ExitCode)
Row 'desktop shortcut → new program (was Electron''s)' ((LnkTarget $deskLnk) -eq $exe) (LnkTarget $deskLnk)
foreach ($k in '.torrent', 'magnet', 'kurokawatools') { $r = Opens-With $k $exe; Row "replaced: $k opens the new program" $r[0] $r[1] }
Row 'Electron program removed (hand-over found)' (-not (Test-Path (Join-Path $old 'resources\app.asar'))) $old
Row 'Electron uninstall entry removed' (-not (Test-Path $ek)) $ek
Row 'Electron data kept' ((Test-Path (Join-Path $edata 'kt-ci-electron-data.txt')) -and (Test-Path (Join-Path $edata 'aria2.session')) -and (Test-Path (Join-Path $edata 'Local Storage'))) $edata
$runOld = (Get-ItemProperty $runKey -ErrorAction SilentlyContinue).'app.kurokawa.tools'
Row 'replaced: the old program''s start at log-in removed' (-not $runOld) "[$runOld]"
Row 'a partial download and its .aria2 file untouched' (((Get-FileHash $partial).Hash + (Get-FileHash "$partial.aria2").Hash) -eq $partialSum) $partial
# (The first-run screen, for real: a profile of its own, emptied after.)
$p = Start-Process $exe -PassThru; Start-Sleep -Seconds 8; Shot 'firstrun-real'; try { Stop-Process -Id $p.Id -Force } catch {}
Start-Sleep -Seconds 2
# (Start-up timing of the installed app, as the Reader's: a cold start, then a warm one — KT_BOOTTIME makes it write
# its first paint and ready (ms from the program's start, boot.rs) and end.)
foreach ($k in 'cold', 'warm') {
  $bt = Join-Path $d "boottime-$k.json"; Remove-Item $bt -ErrorAction SilentlyContinue; $env:KT_BOOTTIME = $bt
  $p = Start-Process $exe -PassThru; $null = $p.Handle
  if (-not $p.WaitForExit(60000)) { try { Stop-Process -Id $p.Id -Force } catch {} }
  Remove-Item Env:KT_BOOTTIME
  $j = if (Test-Path $bt) { Get-Content $bt -Raw | ConvertFrom-Json } else { $null }
  Row "start-up ($k): first paint, app ready" ($null -ne $j -and $null -ne $j.ready) $(if ($j) { $j.line } else { 'not written' }) $false
}

# 3. The installed app's own self-test, both parts (as the self-test step runs the bare program).
$code = 0
foreach ($part in 1, 2) {
  $out = Join-Path $d "selftest-installed-$part.json"; $env:KT_SELFTEST = $out; $env:KT_SELFTEST_PART = "$part"; $env:KT_SELFTEST_TIMEOUT = '290'; $env:KT_SELFTEST_BUNDLED = '1'
  $p = Start-Process $exe -PassThru; $null = $p.Handle
  if ($p.WaitForExit(340000)) { $c = $p.ExitCode } else { Stop-Process -Id $p.Id -Force; $c = 124 }
  node ../selftest-report.cjs $out $c "Windows (installed, part $part of 2)" | Out-File (Join-Path $d "selftest-installed-$part.md")
  Get-Content (Join-Path $d "selftest-installed-$part.md") | Write-Host
  if ($c -ne 0 -and $code -eq 0) { $code = $c }
}
Remove-Item Env:KT_SELFTEST, Env:KT_SELFTEST_PART
Row 'self-test of the installed app' ($code -eq 0) "exit $code"

# 4. A higher version over it, as the app's updater runs its installer (/P /R /UPDATE: update.rs).
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
  $cfgDir = Join-Path $env:APPDATA 'app.kurokawa.tools'; $locDir = Join-Path $env:LOCALAPPDATA 'app.kurokawa.tools'
  foreach ($m in @($cfgDir, $locDir)) { New-Item -ItemType Directory -Force -Path $m | Out-Null; Set-Content (Join-Path $m 'kt-ci-marker.txt') "kept since $v1" }
  $u = Join-Path $env:TEMP "KurokawaTools-update-ci-$v2.exe"; Copy-Item $setup2.FullName $u -Force
  $p = Start-Process $u -ArgumentList '/P', '/R', '/UPDATE' -PassThru
  $sw = [Diagnostics.Stopwatch]::StartNew(); $pictured = $false
  while ($sw.Elapsed.TotalSeconds -lt 150) { if (-not $pictured -and $sw.Elapsed.TotalSeconds -ge 1) { Shot 'update-installer'; $pictured = $true }; if ($p.HasExited -and -not (Installers $dir).Count) { break }; Start-Sleep -Milliseconds 250 }
  $now = $null
  for ($i = 0; $i -lt 10; $i++) { $now = (Get-ItemProperty "$UninstKey\$Product" -ErrorAction SilentlyContinue).DisplayVersion; if ($now -eq $v2) { break }; Start-Sleep -Seconds 1 }
  Start-Sleep -Seconds 2
  Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force
  Row "installed version $v1 → $v2 (the installer as the updater runs it)" ($now -eq $v2) $(if ($now) { $now } else { 'none' })
  Row 'install trace (installer/hooks.nsh)' (Test-Path $trace) $(if (Test-Path $trace) { ((Get-Content $trace) | ForEach-Object { ($_ -split ' tick=')[0] }) -join ' → ' } else { 'not written' }) $false
  Row 'data kept over the update' ((Test-Path (Join-Path $cfgDir 'kt-ci-marker.txt')) -and (Test-Path (Join-Path $locDir 'kt-ci-marker.txt'))) "$cfgDir, $locDir"
  Row 'desktop shortcut kept' ((LnkTarget $deskLnk) -eq $exe) (LnkTarget $deskLnk)
}

# 5. Uninstalled silently: program gone, data kept.
if (Test-Path $un) {
  Start-Process $un -ArgumentList '/S' -Wait
  for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
  Row 'uninstalled' (-not (Test-Path $exe) -and -not (Test-Path "$UninstKey\$Product")) $dir
} else { Row 'uninstalled' $false "no uninstaller at $un" }
Row 'data folders kept after uninstall' (Test-Path (Join-Path $env:APPDATA 'app.kurokawa.tools\kt-ci-marker.txt')) 'app.kurokawa.tools in Roaming'
Row 'Electron data still kept' (Test-Path (Join-Path $edata 'kt-ci-electron-data.txt')) $edata
# (The Electron data made here goes, so the hand-over steps after start from a real Electron profile.)
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $edata
Remove-ItemProperty $runKey 'app.kurokawa.tools', 'Kurokawa Tools' -ErrorAction SilentlyContinue
foreach ($s in 'magnet', 'kurokawatools', 'KurokawaToolsElectron.torrent') { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "HKCU:\Software\Classes\$s" }

$summary = @('### Windows — the installer, end to end (Tools P9)', '', '| Check | | Detail |', '|---|---|---|') + $rows + @('', "Pictures and logs: artifact tauri-tools-install-windows. Failures: $($fails.Count)")
$summary -join "`n" | Out-File -Append -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8
$summary -join "`n" | Out-File -FilePath (Join-Path $d 'summary.md') -Encoding utf8
if ($fails.Count) { Write-Host "FAILED: $($fails -join ', ')"; exit 1 }
