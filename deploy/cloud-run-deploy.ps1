param(
  [string]$Project = 'gen-lang-client-0335766885',
  [string]$Region = 'europe-west1',
  [string]$Service = 'chatbot-tkw',
  [string]$EnvFile = "$PSScriptRoot\env\server.env",
  [string]$SecretName = 'vertex-service-account-json'
)

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  Write-Error 'gcloud CLI is not installed or not available in PATH. Install Google Cloud SDK before running this script.'
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

$setVars = @()
foreach ($key in $envData.Keys) {
  if ($key -eq 'GOOGLE_APPLICATION_CREDENTIALS') { continue }
  if ($key -eq 'VERTEX_SERVICE_ACCOUNT_JSON') { continue }
  $setVars += "$key=$($envData[$key])"
}

$secretArgs = @()
if ($envData.ContainsKey('VERTEX_SERVICE_ACCOUNT_JSON')) {
  $secretArgs += "VERTEX_SERVICE_ACCOUNT_JSON=$SecretName:latest"
  if (-not (gcloud secrets describe $SecretName --project $Project 2>$null)) {
    Write-Host "Creating secret $SecretName in project $Project..."
    gcloud secrets create $SecretName --project=$Project --replication-policy=automatic
  }
  Write-Host "Updating secret $SecretName with currently defined VERTEX_SERVICE_ACCOUNT_JSON value..."
  $tmpFile = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tmpFile -Value $envData['VERTEX_SERVICE_ACCOUNT_JSON'] -NoNewline
  gcloud secrets versions add $SecretName --data-file=$tmpFile --project=$Project
  Remove-Item $tmpFile
} elseif ($envData.ContainsKey('GOOGLE_APPLICATION_CREDENTIALS')) {
  $gcpPath = $envData['GOOGLE_APPLICATION_CREDENTIALS']
  if (-not (Test-Path $gcpPath)) {
    Write-Warning "Google service account file path does not exist locally: $gcpPath"
    Write-Warning 'You must create or mount the Vertex service account JSON as a Secret Manager secret, or update VERTEX_SERVICE_ACCOUNT_JSON in the env file.'
  } else {
    if (-not (gcloud secrets describe $SecretName --project $Project 2>$null)) {
      Write-Host "Creating secret $SecretName in project $Project..."
      gcloud secrets create $SecretName --project=$Project --replication-policy=automatic
    }
    Write-Host "Updating secret $SecretName with service account file from $gcpPath..."
    gcloud secrets versions add $SecretName --data-file=$gcpPath --project=$Project
    $secretArgs += "VERTEX_SERVICE_ACCOUNT_JSON=$SecretName:latest"
  }
}

$setEnvArgument = $setVars -join ','

Write-Host 'Deploying Cloud Run service...'
$sourcePath = (Resolve-Path "$PSScriptRoot\.." ).Path
$deployArgs = @(
  'run', 'deploy', $Service,
  '--project', $Project,
  '--region', $Region,
  '--platform', 'managed',
  '--source', $sourcePath,
  '--allow-unauthenticated'
)
if ($setEnvArgument) { $deployArgs += @('--set-env-vars', $setEnvArgument) }
if ($secretArgs.Count -gt 0) { $deployArgs += @('--update-secrets', ($secretArgs -join ',')) }

Write-Host "gcloud $($deployArgs -join ' ')"
gcloud @deployArgs
