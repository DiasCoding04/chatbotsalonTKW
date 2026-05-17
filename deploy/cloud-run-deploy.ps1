param(
  [string]$Project = 'gen-lang-client-0335766885',
  [string]$Region = 'asia-southeast1',
  [string]$Service = 'chatbot-tkw',
  [string]$EnvFile = "$PSScriptRoot\env\server.env",
  [string]$SecretName = 'vertex-service-account-json',
  [string]$LiveServiceUrl = 'https://chatbot-tkw-482155434300.asia-southeast1.run.app',
  # Vertex + CONTEXT lớn: 512Mi dễ OOM/502 — mặc định nâng RAM (chỉnh -Memory hoặc gcloud patch).
  [string]$Memory = '2Gi',
  [string]$Cpu = '1',
  [switch]$SkipContextSync,
  # Mặc định xóa toàn bộ Vertex cache sau deploy (tránh cache cũ + fingerprint lệch).
  [switch]$SkipPurgeContextCache
)

# ============================================================
# Pre-deploy: sync seed files from LIVE production
# ------------------------------------------------------------
# Each new Cloud Run revision is a fresh container; the server seeds
# data/CONTEXT.md (+ data/IMAGE_SAMPLES.md) from public/<file>.md baked
# into the image. If those public/ copies are stale, every deploy will
# silently overwrite live-edited context. We pull the current live
# version from the existing service and write it to public/ before the
# image build, so the seed ALWAYS matches what production already has.
# ============================================================
if (-not $SkipContextSync) {
  $sourcePath = (Resolve-Path "$PSScriptRoot\..").Path
  $contextTargets = @(
    @{ Endpoint = '/api/context';        Local = (Join-Path $sourcePath 'public\CONTEXT.md') },
    @{ Endpoint = '/api/image-samples';  Local = (Join-Path $sourcePath 'public\IMAGE_SAMPLES.md') }
  )
  foreach ($t in $contextTargets) {
    $url = "$LiveServiceUrl$($t.Endpoint)"
    Write-Host "[context-sync] Pulling live $($t.Endpoint) -> $($t.Local)"
    try {
      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30
      if ($resp.StatusCode -ne 200) { throw "HTTP $($resp.StatusCode)" }
      $doc = $resp.Content | ConvertFrom-Json
      if ($null -eq $doc.content -or $doc.content.Length -lt 8) {
        Write-Warning "[context-sync] Live $($t.Endpoint) returned empty content ($($doc.content.Length) chars). Keeping existing local copy."
        continue
      }
      $localBytes = if (Test-Path $t.Local) { (Get-Item $t.Local).Length } else { 0 }
      if ($localBytes -gt $doc.content.Length) {
        Write-Host "[context-sync]   Keep local ($localBytes bytes) - fuller than live ($($doc.content.Length) chars)."
        continue
      }
      [System.IO.File]::WriteAllText($t.Local, $doc.content, [System.Text.UTF8Encoding]::new($false))
      $newBytes = (Get-Item $t.Local).Length
      Write-Host "[context-sync]   OK: $($doc.content.Length) chars -> $newBytes bytes (was $localBytes)"
    } catch {
      Write-Warning "[context-sync] FAILED to pull $url : $_"
      Write-Warning "[context-sync] If you continue, the LOCAL copy of $($t.Local) will be baked into the image and may overwrite live context on cold-start."
      $ans = Read-Host '[context-sync] Continue anyway? (y/N)'
      if ($ans -ne 'y' -and $ans -ne 'Y') { Write-Error 'Deploy aborted by user.'; exit 2 }
    }
  }
} else {
  Write-Warning '[context-sync] -SkipContextSync set; local public/CONTEXT.md will be baked into the image as-is. Live context may be overwritten.'
}

$gcloudCmd = Get-Command gcloud -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
if (-not $gcloudCmd) {
  $fallbackPaths = @(
    'C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd',
    'C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd',
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
  )
  foreach ($fallbackPath in $fallbackPaths) {
    if (Test-Path $fallbackPath) {
      $gcloudCmd = $fallbackPath
      break
    }
  }
}

if (-not $gcloudCmd) {
  Write-Error 'gcloud CLI is not installed or not available in PATH. Install Google Cloud SDK or add it to PATH before running this script.'
  exit 1
}

if (-not (Test-Path $EnvFile)) {
  Write-Error "Environment file not found: $EnvFile"
  exit 1
}

$envData = @{}
Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $pair = $line -split('=', 2)
  if ($pair.Length -ne 2) { return }
  $key = $pair[0].Trim()
  $value = $pair[1].Trim()
  $envData[$key] = $value
}

$runtimeEnvPath = [System.IO.Path]::GetTempFileName()
$runtimeEnvLines = @()
foreach ($key in $envData.Keys) {
  if ($key -eq 'GOOGLE_APPLICATION_CREDENTIALS') { continue }
  if ($key -eq 'VERTEX_SERVICE_ACCOUNT_JSON') { continue }
  $val = [string]$envData[$key]
  $escaped = $val.Replace("'", "''")
  $runtimeEnvLines += "${key}: '$escaped'"
}
Set-Content -Path $runtimeEnvPath -Value ($runtimeEnvLines -join [Environment]::NewLine) -NoNewline

$secretArgs = @()
if ($envData.ContainsKey('VERTEX_SERVICE_ACCOUNT_JSON')) {
  $secretArgs += "VERTEX_SERVICE_ACCOUNT_JSON=$SecretName:latest"
  if (-not (& $gcloudCmd secrets describe $SecretName --project $Project 2>$null)) {
    Write-Host "Creating secret $SecretName in project $Project..."
    & $gcloudCmd secrets create $SecretName --project=$Project --replication-policy=automatic --quiet
  }
  Write-Host "Updating secret $SecretName with currently defined VERTEX_SERVICE_ACCOUNT_JSON value..."
  $tmpFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tmpFile -Value $envData['VERTEX_SERVICE_ACCOUNT_JSON'] -NoNewline
  & $gcloudCmd secrets versions add $SecretName --data-file=$tmpFile --project=$Project --quiet
  Remove-Item $tmpFile
} elseif ($envData.ContainsKey('GOOGLE_APPLICATION_CREDENTIALS')) {
  $gcpPath = $envData['GOOGLE_APPLICATION_CREDENTIALS']
  if (-not (Test-Path $gcpPath)) {
    Write-Warning "Google service account file path does not exist locally: $gcpPath"
    Write-Warning 'You must create or mount the Vertex service account JSON as a Secret Manager secret, or update VERTEX_SERVICE_ACCOUNT_JSON in the env file.'
  } else {
    if (-not (& $gcloudCmd secrets describe $SecretName --project $Project 2>$null)) {
      Write-Host "Creating secret $SecretName in project $Project..."
      & $gcloudCmd secrets create $SecretName --project=$Project --replication-policy=automatic --quiet
    }
    Write-Host "Updating secret $SecretName with service account file from $gcpPath..."
    & $gcloudCmd secrets versions add $SecretName --data-file=$gcpPath --project=$Project --quiet
    $secretArgs += "VERTEX_SERVICE_ACCOUNT_JSON=$SecretName:latest"
  }
}

Write-Host 'Deploying Cloud Run service...'
$sourcePath = (Resolve-Path "$PSScriptRoot\.." ).Path
$deployArgs = @(
  'run', 'deploy', $Service,
  '--project', $Project,
  '--region', $Region,
  '--platform', 'managed',
  '--source', $sourcePath,
  '--allow-unauthenticated',
  '--quiet'
)
$deployArgs += @('--env-vars-file', $runtimeEnvPath)
$deployArgs += @('--memory', $Memory, '--cpu', $Cpu, '--max-instances', '5')
if ($secretArgs.Count -gt 0) { $deployArgs += @('--update-secrets', ($secretArgs -join ',')) }

Write-Host "& $gcloudCmd $($deployArgs -join ' ')"
& $gcloudCmd @deployArgs
$exitCode = $LASTEXITCODE
Remove-Item $runtimeEnvPath -ErrorAction SilentlyContinue

if ($exitCode -eq 0 -and -not $SkipPurgeContextCache) {
  $editorToken = $envData['CONTEXT_EDITOR_TOKEN']
  if ($editorToken) {
    Write-Host "[context-cache] Post-deploy: purge all remote cachedContents at $LiveServiceUrl ..."
    try {
      $purgeResp = Invoke-RestMethod -Uri "$LiveServiceUrl/api/context-cache/purge" -Method POST -Headers @{
        'X-Context-Edit-Token' = $editorToken
      } -TimeoutSec 120
      Write-Host "[context-cache] Purge OK - deletedRemote=$($purgeResp.deletedRemote)"
    } catch {
      Write-Warning "[context-cache] Post-deploy purge failed: $_"
    }
  } else {
    Write-Warning '[context-cache] CONTEXT_EDITOR_TOKEN missing in env file - skip post-deploy purge.'
  }
} elseif ($exitCode -eq 0) {
  Write-Host '[context-cache] Post-deploy purge skipped (-SkipPurgeContextCache).'
}

Write-Host '[ops] Builds: nếu gcloud builds list rỗng — kiểm tra IAM roles (Cloud Build Viewer) hoặc dùng GCP Console khác source-based deploy.'
Write-Host "[ops] Đặt RAM mà không build lại: deploy\patch-cloud-run-memory.ps1 - hoặc: gcloud run services update $Service --region=$Region --project=$Project --memory=$Memory"

exit $exitCode
