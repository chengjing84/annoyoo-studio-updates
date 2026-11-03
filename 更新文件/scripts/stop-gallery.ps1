$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$record = Get-Content -LiteralPath (Join-Path $projectRoot '.local\server-instance.json') -Raw | ConvertFrom-Json
$url = "http://127.0.0.1:$($record.port)"
$health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 3
if ($health.projectRoot -ne $projectRoot -or $health.pid -ne $record.pid) { throw 'Server identity does not match this package. No process was stopped.' }
Invoke-RestMethod -Uri "$url/api/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
if ($health.edition -eq 'studio') { Write-Host 'The studio and its owned services are stopping.' }
elseif ($health.edition -eq 'api') { Write-Host 'The API edition gallery is stopping.' }
else { Write-Host 'Gallery and its owned built-in engine are stopping. External ComfyUI is unchanged.' }
