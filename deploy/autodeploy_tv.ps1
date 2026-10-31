$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$ErrorActionPreference = 'Stop'
$repo   = 'C:\Sites\aegis-tv-suite'
$logDir = 'C:\Sites\deploy_logs'
$log    = Join-Path $logDir 'autodeploy.log'
New-Item -ItemType Directory -Force $logDir | Out-Null
Set-Content -Path (Join-Path $logDir 'last_run.txt') -Value (Get-Date -Format s)
function Log($m) { '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m | Add-Content -Path $log -Encoding utf8 }

$mutex = New-Object System.Threading.Mutex($false, 'Global\punks_tv_autodeploy')
if ($mutex.WaitOne(0)) {
  try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Move-Item $log "$log.old" -Force }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    git -C $repo fetch --quiet origin main 2>&1 | Out-Null
    $fetchSecs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    if ($LASTEXITCODE) {
      Log "fetch failed (exit $LASTEXITCODE) - credentials or network"
    } else {
      $local  = (git -C $repo rev-parse HEAD).Trim()
      $remote = (git -C $repo rev-parse origin/main).Trim()
      if ($local -ne $remote) {
        $short   = $remote.Substring(0, 7)
        $changed = @(git -C $repo diff --name-only $local $remote -- web)
        if ($changed.Count -eq 0) {
          git -C $repo pull --ff-only --quiet origin main 2>&1 | Out-Null
          if ($LASTEXITCODE) { Log "pull failed at $short" } else { Log "advanced to $short (no web/ changes, not deploying)" }
        } else {
          Log "deploying $short ($($changed.Count) web file(s); fetch took ${fetchSecs}s)"
          $out  = & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File 'C:\Sites\deploy_tv.ps1' 2>&1
          $code = $LASTEXITCODE
          $out | ForEach-Object { Log "   $_" }
          if ($code) { Log "DEPLOY FAILED (exit $code)" } else { Log "deploy ok ($([math]::Round($sw.Elapsed.TotalSeconds, 1))s since start)" }
          Get-ChildItem 'C:\Sites\deploy_backups' -Directory | Sort-Object Name -Descending | Select-Object -Skip 20 | Remove-Item -Recurse -Force
        }
      }
    }
  } catch { Log "ERROR: $_" }
  finally { $mutex.ReleaseMutex() }
}

