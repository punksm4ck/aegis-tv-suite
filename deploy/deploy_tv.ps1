$ErrorActionPreference = 'Stop'
$repo = "C:\Sites\aegis-tv-suite"
$live = "C:\Sites\punksm4ck_tv\wwwroot"
$web  = Join-Path $repo "web"

$restartFiles = @(git -C $repo diff --name-only HEAD origin/main -- web | Where-Object { $_ -match '^web/(server\.js|dvr\.js|package-lock\.json)$' })
if ($restartFiles.Count -gt 0 -and -not (Test-Path 'C:\Sites\force_deploy.txt')) {
  $recJobs = @()
  try { $recJobs = @(Get-Content "$live\data\dvr_web_jobs.json" -Raw | ConvertFrom-Json | Where-Object { $_.status -eq 'recording' }) } catch {}
  if ($recJobs.Count -gt 0) { Write-Host "DEFERRED: $($recJobs.Count) recording(s) in progress, restart needed for $($restartFiles -join ', ')"; exit 0 }
}
git -C $repo pull --ff-only
if ($LASTEXITCODE) { throw "git pull failed" }
if (-not (Test-Path "$web\server.js")) { throw "web\server.js missing in repo - aborting" }

$srvBefore  = (Get-FileHash "$live\server.js").Hash
$lockBefore = (Get-FileHash "$live\package-lock.json").Hash
$dvrBefore  = (Get-FileHash "$live\dvr.js").Hash

$bk = "C:\Sites\deploy_backups\" + (Get-Date -Format yyyyMMdd_HHmmss)
New-Item -ItemType Directory -Force $bk | Out-Null
Copy-Item "$live\server.js", "$live\dvr.js", "$live\package.json", "$live\package-lock.json" $bk
Copy-Item "$live\public" "$bk\public" -Recurse

robocopy $web $live server.js dvr.js package.json package-lock.json /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (root files) failed: $LASTEXITCODE" }
robocopy "$web\public" "$live\public" /E /XF *.bak* /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (public) failed: $LASTEXITCODE" }

node --check "$live\server.js"
if ($LASTEXITCODE) {
  Copy-Item "$bk\server.js" "$live\server.js" -Force
  throw "server.js failed syntax check - restored previous version"
}

$lockChanged = (Get-FileHash "$live\package-lock.json").Hash -ne $lockBefore
$srvChanged  = (Get-FileHash "$live\server.js").Hash -ne $srvBefore
$dvrChanged  = (Get-FileHash "$live\dvr.js").Hash -ne $dvrBefore
if ($lockChanged) { Push-Location $live; npm ci --omit=dev; Pop-Location }
if ($lockChanged -or $srvChanged -or $dvrChanged) { nssm restart punksm4ck-tv; Write-Host "service restarted" }
else { Write-Host "front-end only - no restart needed" }
Write-Host "deployed. backup: $bk"
