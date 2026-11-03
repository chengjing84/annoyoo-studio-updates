param(
    [Parameter(Mandatory=$true)][string]$ArchivePath,
    [Parameter(Mandatory=$true)][string]$RootPath,
    [Parameter(Mandatory=$true)][string]$StagePath,
    [Parameter(Mandatory=$true)][string]$PackageId
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$runtimeRoot = [IO.Path]::GetFullPath($RootPath)
$stageRoot = [IO.Path]::GetFullPath($StagePath)
$safePrefix = [IO.Path]::GetFullPath((Join-Path $runtimeRoot '.local')) + [IO.Path]::DirectorySeparatorChar + 'runtime-install-'
if (-not $stageRoot.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation staging directory.' }
if (Test-Path -LiteralPath $stageRoot) { throw 'Installation staging directory already exists.' }
function Long-Path([string]$value) {
    if ($value.StartsWith('\\')) { return '\\?\UNC\' + $value.Substring(2) }
    return '\\?\' + $value
}
function Allowed-Name([string]$value) {
    if (-not $value -or $value.Contains('\') -or $value.Contains(':') -or $value.StartsWith('/') -or $value.Contains([char]0)) { return $false }
    foreach ($part in $value.Split('/')) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>"|?*]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { return $false }
    }
    if ($value -eq 'runtime/runtime-manifest.json' -or $value -eq 'runtime/redist/VC_redist.x64.exe') { return $true }
    if (-not ($value.StartsWith('runtime/comfyui/python/') -or $value.StartsWith('runtime/comfyui/ComfyUI/'))) { return $false }
    if ($value -match '^runtime/comfyui/ComfyUI/(models|input|output|temp|user|custom_nodes)/' -or $value -match '\.(safetensors|ckpt|gguf)$') { return $false }
    return $true
}
$archive = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ArchivePath))
try {
    $manifestEntries = @($archive.Entries | Where-Object { $_.FullName -eq 'environment-manifest.json' })
    if ($manifestEntries.Count -ne 1 -or $manifestEntries[0].Length -gt 33554432) { throw 'Missing or invalid environment manifest.' }
    $manifestReader = New-Object IO.StreamReader($manifestEntries[0].Open())
    try { $manifest = $manifestReader.ReadToEnd() | ConvertFrom-Json } finally { $manifestReader.Dispose() }
    if ($manifest.formatVersion -ne 1 -or $manifest.packageId -cne $PackageId -or -not $manifest.files -or $manifest.files.Count -gt 200000) { throw 'Environment package identity does not match.' }
    $expected = New-Object 'System.Collections.Generic.Dictionary[string,long]' ([StringComparer]::OrdinalIgnoreCase)
    $total = [long]0
    foreach ($file in $manifest.files) {
        if (-not (Allowed-Name $file.path) -or $expected.ContainsKey($file.path) -or [long]$file.bytes -lt 0) { throw 'Unsafe or duplicate environment manifest path.' }
        $expected.Add($file.path, [long]$file.bytes); $total += [long]$file.bytes
    }
    if ($total -gt 214748364800) { throw 'Environment expands beyond the supported size.' }
    $actual = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -eq 'environment-manifest.json') { continue }
        if (-not (Allowed-Name $entry.FullName) -or -not $expected.ContainsKey($entry.FullName) -or $entry.Length -ne $expected[$entry.FullName] -or -not $actual.Add($entry.FullName)) { throw 'ZIP contents do not match the environment manifest.' }
        $unixKind = (($entry.ExternalAttributes -shr 16) -band 61440)
        if ($unixKind -eq 40960) { throw 'Linked ZIP entries are not allowed.' }
    }
    if ($actual.Count -ne $expected.Count) { throw 'Environment package files are missing.' }
    [IO.Directory]::CreateDirectory((Long-Path $stageRoot)) | Out-Null
    $completed = [long]0; $nextReport = [long]0
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -eq 'environment-manifest.json') { continue }
        $target = [IO.Path]::GetFullPath((Join-Path $stageRoot ($entry.FullName.Replace('/', '\'))))
        if (-not $target.StartsWith($stageRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP entry escapes installation directory.' }
        [IO.Directory]::CreateDirectory((Long-Path ([IO.Path]::GetDirectoryName($target)))) | Out-Null
        $inputStream = $entry.Open()
        $outputStream = [IO.File]::Open((Long-Path $target), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        $completed += $entry.Length
        if ($completed -ge $nextReport) { Write-Output ('PROGRESS ' + $completed + ' ' + $total); $nextReport = $completed + 16777216 }
    }
    Write-Output ('PROGRESS ' + $total + ' ' + $total)
} finally { $archive.Dispose() }
