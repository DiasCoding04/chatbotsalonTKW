$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$envPath = Join-Path $root '.env.vertex.local'

if (!(Test-Path $envPath)) {
  throw "Missing $envPath. Copy .env.vertex.local.example to .env.vertex.local first."
}

Get-Content $envPath | ForEach-Object {
  $line = $_.Trim()
  if (!$line -or $line.StartsWith('#')) { return }
  $i = $line.IndexOf('=')
  if ($i -le 0) { return }
  $key = $line.Substring(0, $i).Trim()
  $value = $line.Substring($i + 1).Trim()
  [Environment]::SetEnvironmentVariable($key, $value, 'Process')
}

Set-Location $root
npm.cmd run dev
