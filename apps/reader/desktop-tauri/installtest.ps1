# The Windows installer, end to end (stage R6b; .github/workflows/tauri-check-reader.yml, Windows only). Run from
# desktop-tauri/src-tauri after the build, the one-page step, the self-test and the engine test:
#   0. an ELECTRON KurokawaReader made to look installed (its folder, uninstall entry, data folder, desktop shortcut,
#      kurokawareader:// link), as electron-builder's per-user installer leaves it;
#   1. REAL screenshots of the installer's window (options closed, then open) and later of the first-run screen;
#   2. the installer run silently (/S): its time; files, uninstall entry, Start-menu and desktop shortcuts, file types
#      and the link checked; the Electron copy's program removed, its data kept, its shortcut and link pointing at the
#      new program;
#   3. the installed app started twice with KR_BOOTTIME (a cold start, then a warm one: first paint, app ready);
#   4. the installed app's self-test (KR_SELFTEST);
#   5. a second build with a higher version made, served as a fake release on 127.0.0.1 (updateserver.cjs: Range, the
#      first download cut off halfway), and installed over the first through the app's OWN updater (KR_UPDATETEST:
#      downloadUpdate → installDownloadedUpdate); the new version in place, a marker in the data folders kept;
#   6. uninstalled silently: the program gone, the data folders (and the library in them) kept.
# Pictures, logs and a summary go to $env:RUNNER_TEMP\kr-install (the workflow keeps it as an artifact).
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
function LnkTarget($p) { if (-not (Test-Path $p)) { return $null }; return (New-Object -ComObject WScript.Shell).CreateShortcut($p).TargetPath }
function MB($f) { '{0:N2} MB' -f ((Get-Item $f).Length / 1MB) }
$UN = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

$setup = Get-ChildItem 'target/release/bundle/nsis/*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'no NSIS installer built' }
$setup1 = Join-Path $d 'setup-1.exe'; Copy-Item $setup.FullName $setup1
$v1 = (node -p "require('../../package.json').version").Trim()
Row 'installer size' $true "$(MB $setup1) ($($setup.Name)); Electron's: 81.6 MB"

# 0. An Electron install, as electron-builder leaves one.
$old = Join-Path $env:LOCALAPPDATA 'Programs\KurokawaReader'
New-Item -ItemType Directory -Force -Path (Join-Path $old 'resources') | Out-Null
Set-Content (Join-Path $old 'resources\app.asar') 'asar'
Copy-Item (Join-Path $env:SystemRoot 'System32\where.exe') (Join-Path $old 'KurokawaReader.exe')
Set-Content (Join-Path $old 'Uninstall KurokawaReader.exe') 'x'
$ek = "$UN\a1b2c3d4-kr-ci-electron"
New-Item $ek -Force | Out-Null
Set-ItemProperty $ek DisplayName 'KurokawaReader'; Set-ItemProperty $ek InstallLocation $old
Set-ItemProperty $ek UninstallString "`"$old\Uninstall KurokawaReader.exe`" /currentuser"
$edata = Join-Path $env:APPDATA 'KurokawaReader'; New-Item -ItemType Directory -Force -Path $edata | Out-Null
Set-Content (Join-Path $edata 'kr-ci-electron-data.txt') 'the Electron library'
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
$e = Get-ItemProperty "$UN\KurokawaReader" -ErrorAction SilentlyContinue
Row 'uninstall entry (HKCU, per user)' ($null -ne $e) ("$($e.DisplayName) $($e.DisplayVersion) — $($e.UninstallString)")
$un = ($e.UninstallString -replace '"', '').Trim(); $dir = Split-Path $un; $exe = Join-Path $dir 'KurokawaReader.exe'
Row 'files' ((Test-Path $exe) -and (Test-Path $un)) "$dir — $((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Count) files, $('{0:N1}' -f ((Get-ChildItem $dir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) MB"
Row 'per user, no admin' ($dir -like "$env:LOCALAPPDATA*") $dir
Row '7-Zip shipped' ((Get-ChildItem $dir -Recurse -Filter '7za.exe' | Measure-Object).Count -gt 0) 'resources\7zip' $false
$start = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter 'KurokawaReader.lnk' | Where-Object { (LnkTarget $_.FullName) -eq $exe }
Row 'Start-menu shortcut' ($start.Count -gt 0) (($start | ForEach-Object { $_.FullName }) -join '; ')
Row 'desktop shortcut → new program (was Electron''s)' ((LnkTarget $deskLnk) -eq $exe) (LnkTarget $deskLnk)
$cls = (Get-ItemProperty 'HKCU:\Software\Classes\.epub' -ErrorAction SilentlyContinue).'(default)'
$cmd = if ($cls) { (Get-ItemProperty "HKCU:\Software\Classes\$cls\shell\open\command" -ErrorAction SilentlyContinue).'(default)' } else { '' }
Row '.epub opens with it' ($cmd -like "*$exe*") ".epub → $cls → $cmd"
$link = (Get-ItemProperty 'HKCU:\Software\Classes\kurokawareader\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
Row 'kurokawareader:// → new program' ($link -like "*$exe*") $link
Row 'Electron program removed' (-not (Test-Path (Join-Path $old 'resources\app.asar'))) $old
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
  $now = $null
  for ($i = 0; $i -lt 120; $i++) { $now = (Get-ItemProperty "$UN\KurokawaReader" -ErrorAction SilentlyContinue).DisplayVersion; if ($now -eq $v2) { break }; Start-Sleep -Seconds 1 }
  Start-Sleep -Seconds 5
  Get-Process KurokawaReader -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Host '--- update test log'; Get-Content $log -ErrorAction SilentlyContinue | Write-Host
  Write-Host '--- server log'; Get-Content (Join-Path $feed 'server.log') -ErrorAction SilentlyContinue | Write-Host
  $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
  Row 'update downloaded (resumed) and checked' ($text -match 'download downloaded') (($text -split "`n" | Where-Object { $_ -match '^download|^install|^FAIL' }) -join ' / ')
  Row 'resumed after a cut' ((Get-Content (Join-Path $feed 'server.log') -Raw) -match 'range \d+-') 'server.log: a Range request after the cut'
  Row "installed version $v1 → $v2 (the app's own updater)" ($now -eq $v2) ("{0} after {1:N0} s" -f $now, $t.TotalSeconds)
  Row 'program version' ((Get-Item $exe).VersionInfo.ProductVersion -like "$v2*") ((Get-Item $exe).VersionInfo.ProductVersion) $false
  Row 'data kept over the update' ((Test-Path (Join-Path $cfgDir 'kr-ci-marker.txt')) -and (Test-Path (Join-Path $locDir 'kr-ci-marker.txt'))) "$cfgDir, $locDir"
  Row 'desktop shortcut kept' ((LnkTarget $deskLnk) -eq $exe) (LnkTarget $deskLnk)
  try { Stop-Process -Id $srv.Id -Force } catch {}
}

# 6. Uninstalled silently: program gone, data kept.
Start-Process $un -ArgumentList '/S' -Wait
for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
Row 'uninstalled' (-not (Test-Path $exe) -and -not (Test-Path "$UN\KurokawaReader")) $dir
Row 'library (data folders) kept after uninstall' ((Test-Path (Join-Path $env:APPDATA 'app.kurokawa.reader\kr-ci-marker.txt')) -and (Test-Path (Join-Path $env:LOCALAPPDATA 'app.kurokawa.reader'))) 'app.kurokawa.reader in Roaming and Local'
Row 'Electron data still kept' (Test-Path (Join-Path $edata 'kr-ci-electron-data.txt')) $edata

$summary = @('### Windows — the installer, end to end (R6b)', '', '| Check | | Detail |', '|---|---|---|') + $rows + @('', "Pictures and logs: artifact tauri-reader-install-windows. Failures: $($fails.Count)")
$summary -join "`n" | Out-File -Append -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8
$summary -join "`n" | Out-File -FilePath (Join-Path $d 'summary.md') -Encoding utf8
if ($fails.Count) { Write-Host "FAILED: $($fails -join ', ')"; exit 1 }
