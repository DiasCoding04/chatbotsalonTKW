param(
  [string]$Project = 'gen-lang-client-0335766885',
  [string]$Region = 'asia-southeast1',
  [string]$Service = 'chatbot-tkw',
  [string]$Memory = '2Gi',
  [string]$Cpu = '1'
)

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
  Write-Error 'gcloud CLI không tìm thấy.'
  exit 1
}

Write-Host "Updating Cloud Run RAM/CPU-only (không rebuild image): $Service -> memory=$Memory cpu=$Cpu"
& $gcloudCmd run services update $Service `
  --project=$Project `
  --region=$Region `
  --memory=$Memory `
  --cpu=$Cpu `
  --quiet

exit $LASTEXITCODE
