param([switch]$CheckOnly)
if ($CheckOnly) { Write-Host "parse ok"; exit 0 }

$ErrorActionPreference = 'Stop'
$repo = "C:\Sites\aegis-tv-suite"
$live = "C:\Sites\punksm4ck_tv\wwwroot"
$web  = Join-Path $repo "web"
$svc  = 'punksm4ck-tv'

# Server-side files live directly in web\ (browser files are in web\public\).
$restartFiles = @(git -C $repo diff --name-only HEAD origin/main -- web | Where-Object { $_ -match '^web/([^/]+\.js|package(-lock)?\.json)$' })
if ($restartFiles.Count -gt 0 -and -not (Test-Path 'C:\Sites\force_deploy.txt')) {
  $recJobs = @()
  try { $recJobs = @(Get-Content "$live\data\dvr_web_jobs.json" -Raw | ConvertFrom-Json | Where-Object { $_.status -eq 'recording' }) } catch {}
  if ($recJobs.Count -gt 0) { Write-Host "DEFERRED: $($recJobs.Count) recording(s) in progress, restart needed for $($restartFiles -join ', ')"; exit 0 }
}

function Get-ServerSnapshot {
  (Get-ChildItem $live -File | Where-Object { $_.Name -match '\.js$|^package(-lock)?\.json$' } |
    Sort-Object Name | ForEach-Object { '{0}:{1}' -f $_.Name, (Get-FileHash $_.FullName).Hash }) -join "`n"
}

# Walks server.js and the ./modules it requires; returns any that do not exist in wwwroot.
function Get-MissingModules {
  $rx = 'require\(\s*[''"]\./([\w.\-]+)[''"]\s*\)'
  $missing = @()
  $seen = @{}
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue('server.js')
  while ($queue.Count -gt 0) {
    $name = $queue.Dequeue()
    if ($seen.ContainsKey($name)) { continue }
    $seen[$name] = $true
    $text = Get-Content (Join-Path $live $name) -Raw
    foreach ($m in [regex]::Matches($text, $rx)) {
      $req = $m.Groups[1].Value
      $hit = @($req, "$req.js", "$req.json") | Where-Object { Test-Path (Join-Path $live $_) } | Select-Object -First 1
      if (-not $hit) { $missing += "$name requires ./$req"; continue }
      if ($hit -like '*.js') { $queue.Enqueue($hit) }
    }
  }
  return $missing
}

function Restore-Backup {
  Get-ChildItem $bk -File | Copy-Item -Destination $live -Force
  robocopy "$bk\public" "$live\public" /E /NFL /NDL /NJH /NJS | Out-Null
}

# Running for 13s without leaving the Running state counts as healthy.
# (NSSM shows Paused when the app keeps exiting right after launch.)
function Wait-ServiceHealthy {
  Start-Sleep -Seconds 8
  if ((Get-Service $svc).Status -ne 'Running') { return $false }
  Start-Sleep -Seconds 5
  return ((Get-Service $svc).Status -eq 'Running')
}

git -C $repo pull --ff-only
if ($LASTEXITCODE) { throw "git pull failed" }
if (-not (Test-Path "$web\server.js")) { throw "web\server.js missing in repo - aborting" }

$snapBefore = Get-ServerSnapshot
$lockBefore = (Get-FileHash "$live\package-lock.json").Hash

$bk = "C:\Sites\deploy_backups\" + (Get-Date -Format yyyyMMdd_HHmmss)
New-Item -ItemType Directory -Force $bk | Out-Null
Get-ChildItem $live -File | Where-Object { $_.Name -match '\.js$|^package(-lock)?\.json$' } | Copy-Item -Destination $bk
Copy-Item "$live\public" "$bk\public" -Recurse

# Every top-level web\*.js is a server module, so new ones no longer need a list entry.
robocopy $web $live *.js package.json package-lock.json /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (root files) failed: $LASTEXITCODE" }
robocopy "$web\public" "$live\public" /E /XF *.bak* /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy (public) failed: $LASTEXITCODE" }

node --check "$live\server.js"
if ($LASTEXITCODE) {
  Restore-Backup
  throw "server.js failed syntax check - restored previous files"
}

$missing = @(Get-MissingModules)
if ($missing.Count -gt 0) {
  Restore-Backup
  throw "missing module(s): $($missing -join '; ') - restored previous files, service untouched"
}
Write-Host "module check ok"

$lockChanged = (Get-FileHash "$live\package-lock.json").Hash -ne $lockBefore
$changed     = (Get-ServerSnapshot) -ne $snapBefore

if ($lockChanged) {
  Push-Location $live
  npm ci --omit=dev
  $npmCode = $LASTEXITCODE
  Pop-Location
  if ($npmCode) {
    Restore-Backup
    throw "npm ci failed ($npmCode) - restored previous files, check node_modules"
  }
}

if ($changed) {
  nssm restart $svc | Out-Null
  if (-not (Wait-ServiceHealthy)) {
    Write-Host "service not healthy after restart (state: $((Get-Service $svc).Status)) - rolling back"
    Restore-Backup
    nssm restart $svc | Out-Null
    if (Wait-ServiceHealthy) { throw "new version failed to start - rolled back, service is running the previous version" }
    throw "new version failed AND rollback did not come up - service is $((Get-Service $svc).Status), manual fix needed"
  }
  Write-Host "service restarted and healthy"
} else {
  Write-Host "front-end only - no restart needed"
}
Write-Host "deployed. backup: $bk"
