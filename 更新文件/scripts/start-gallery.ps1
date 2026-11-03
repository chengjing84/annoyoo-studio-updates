param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.local'
$edition = 'local'
$editionPath = Join-Path $projectRoot 'config\edition.json'
if (Test-Path -LiteralPath $editionPath) {
    $editionConfig = Get-Content -LiteralPath $editionPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($editionConfig.edition -in @('api', 'studio')) { $edition = $editionConfig.edition }
}
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$portableNode = Join-Path $projectRoot 'runtime\node\node.exe'
try {
    $nodeExecutable = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node -ErrorAction Stop).Source }
    $nodeVersion = & $nodeExecutable --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }
} catch { Write-Host "Node.js check failed: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
function Get-GalleryHealth([int]$candidatePort) {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$candidatePort/api/health" -TimeoutSec 2 } catch { return $null }
}
function Test-FreePort([int]$candidatePort) {
    $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidatePort)
    try { $portProbe.Start(); return $true } catch { return $false } finally { $portProbe.Stop() }
}
$requestedPort = if ($env:GALLERY_PORT) { [int]$env:GALLERY_PORT } else { 8765 }
if ($requestedPort -lt 1024 -or $requestedPort -gt 65535) { throw 'Invalid GALLERY_PORT.' }
$galleryPort = $null
$galleryHealth = $null
foreach ($candidatePort in $requestedPort..([Math]::Min(65535, $requestedPort + 40))) {
    $candidateHealth = Get-GalleryHealth $candidatePort
    if ($candidateHealth -and $candidateHealth.projectRoot -eq $projectRoot -and $candidateHealth.edition -ne $edition) {
        Write-Host 'This project is running another edition. Stop that gallery before starting this edition.' -ForegroundColor Yellow
        exit 1
    }
    if ($candidateHealth -and $candidateHealth.projectRoot -eq $projectRoot -and $candidateHealth.edition -eq $edition) { $galleryPort = $candidatePort; $galleryHealth = $candidateHealth; break }
    if (Test-FreePort $candidatePort) { $galleryPort = $candidatePort; break }
}
if (-not $galleryPort) { throw 'No free gallery port was found.' }
$galleryUrl = "http://127.0.0.1:$galleryPort"
if (-not $galleryHealth) {
    $serverEntry = switch ($edition) { 'api' { 'api-server.mjs' }; 'studio' { 'studio-server.mjs' }; default { 'gallery-server.mjs' } }
    $serverFile = Join-Path $PSScriptRoot $serverEntry
    $serverArguments = @('"' + $serverFile + '"')
    if ($edition -in @('api', 'studio') -and $nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 25) {
        $serverArguments = @('--use-env-proxy', '--use-system-ca') + $serverArguments
    }
    $previousPort = $env:GALLERY_PORT
    $previousRoot = $env:GALLERY_ROOT
    $previousNoProxy = $env:NO_PROXY
    try {
        $env:GALLERY_PORT = [string]$galleryPort
        $env:GALLERY_ROOT = $projectRoot
        if ($edition -in @('api', 'studio')) { $env:NO_PROXY = @($previousNoProxy, '127.0.0.1', 'localhost', '::1') -join ',' }
        $serverProcess = Start-Process -FilePath $nodeExecutable -ArgumentList $serverArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'server.log') -RedirectStandardError (Join-Path $runtimeRoot 'server-error.log') -PassThru
    } finally { $env:GALLERY_PORT = $previousPort; $env:GALLERY_ROOT = $previousRoot; $env:NO_PROXY = $previousNoProxy }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 400
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
        $galleryHealth = Get-GalleryHealth $galleryPort
        if ($galleryHealth -and $galleryHealth.projectRoot -eq $projectRoot) { break }
    }
    if (-not $galleryHealth) { Write-Host 'Could not start the gallery. See .local/server-error.log.' -ForegroundColor Red; exit 1 }
}
@{ pid = $galleryHealth.pid; port = $galleryPort; projectRoot = $projectRoot } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'server-instance.json') -Encoding utf8
Set-Content -LiteralPath (Join-Path $runtimeRoot 'server.pid') -Value $galleryHealth.pid -Encoding ascii
Write-Host "POSE Atlas: $galleryUrl" -ForegroundColor Green
if ($edition -eq 'studio') { Write-Host 'Choose API, built-in WebUI or an existing ComfyUI in the setup page.' }
elseif ($edition -eq 'api') { Write-Host 'API edition: configure your image API endpoint, API key and model in the app.' }
else { Write-Host 'Local edition: built-in ComfyUI or connect to your existing ComfyUI.' }
Write-Host "Output: $(Join-Path $projectRoot 'output')"
if (-not $NoBrowser) { Start-Process $galleryUrl }
