param(
    [string]$RootPath,
    [string]$LocalUpdatePath,
    [switch]$CheckOnly,
    [switch]$Apply,
    [switch]$Interactive,
    [switch]$Restart
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$defaultRepository = 'https://github.com/chengjing84/annoyoo-studio-updates'
$headers = @{ 'User-Agent' = 'ANNOYoo-Studio-Updater'; Accept = 'application/vnd.github+json' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$changed = [Collections.Generic.List[object]]::new()
$backupRoot = $null
$stoppedService = $false
$restartAttempted = $false
$serverPort = $null
$updateLock = $null

function Read-JsonFile([string]$File) { return Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-JsonFile([string]$File, $Value) { $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $File -Encoding UTF8 }
function Assert-Unlinked([string]$File) {
    $current = [IO.Path]::GetFullPath($File)
    while ($current -and $current.StartsWith($script:RootPath, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '更新目录包含链接或联接，请使用实际的整合包目录。' }
        }
        if ($current -eq $script:RootPath) { break }
        $current = Split-Path -Parent $current
    }
}
function Safe-Child([string]$Parent, [string]$Relative) {
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $target = [IO.Path]::GetFullPath((Join-Path $parentFull $Relative))
    if (-not $target.StartsWith($parentFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '更新文件路径超出允许目录。' }
    Assert-Unlinked $target
    return $target
}
function Assert-PayloadPath([string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains('\') -or $Relative -match '[:*?"<>|\x00-\x1f]' -or @($Relative.Split('/') | Where-Object { $_ -in @('', '.', '..', '.git', '.local') -or $_.EndsWith('.') -or $_.EndsWith(' ') }).Count) { throw '更新清单包含不安全的文件路径。' }
    $parts = $Relative.Split('/')
    $roots = @('index.html', 'LICENSE', 'README.md', 'og-cover.jpg', 'robots.txt', 'sitemap.xml', '启动创作台.cmd', '停止创作台.cmd', '修复运行库.cmd', '更新创作台.cmd', '使用说明.txt')
    if ($parts.Count -eq 1) { if ($Relative -notin $roots) { throw "不允许更新根目录文件：$Relative" } }
    elseif ($parts[0] -notin @('assets', 'config', 'data', 'scripts', 'docs')) { throw "不允许更新此目录：$($parts[0])" }
    if ($Relative -ne 'LICENSE' -and [IO.Path]::GetExtension($Relative).ToLowerInvariant() -notin @('.html', '.css', '.js', '.mjs', '.json', '.csv', '.md', '.txt', '.ps1', '.cmd', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.mp4', '.xml')) { throw '更新文件类型不受支持。' }
}
function File-Matches([string]$File, $Entry) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $File).Length -ne [long]$Entry.bytes) { return $false }
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($File)
    try { $digest = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hash.Dispose() }
    return $digest -eq $Entry.sha256.ToLowerInvariant()
}
function Version-Value([string]$Value) {
    if ($Value -notmatch '^\d+\.\d+\.\d+$') { throw '版本号格式不正确，请使用完整整合包。' }
    return [version]$Value
}
function Restart-Studio {
    $startScript = Join-Path $script:RootPath 'scripts/start-gallery.ps1'
    $oldPort = $env:GALLERY_PORT
    try {
        if ($script:serverPort) { $env:GALLERY_PORT = [string]$script:serverPort }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -NoBrowser
        if ($LASTEXITCODE -ne 0) { throw '启动失败，请双击“启动创作台.cmd”查看本机日志。' }
    } finally { $env:GALLERY_PORT = $oldPort }
}

try {
    if (-not $RootPath) {
        if ($CheckOnly -or -not $Interactive) { throw '请指定整合包目录。' }
        Add-Type -AssemblyName System.Windows.Forms
        $picker = New-Object System.Windows.Forms.FolderBrowserDialog
        try {
            $picker.Description = '选择含“启动创作台.cmd”的整合包根目录'
            $picker.ShowNewFolderButton = $false
            if ($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
            $RootPath = $picker.SelectedPath
        } finally { $picker.Dispose() }
    }
    $RootPath = [IO.Path]::GetFullPath($RootPath).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath (Join-Path $RootPath '启动创作台.cmd') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $RootPath 'config/distribution.json') -PathType Leaf)) { throw '所选目录不是完整整合包，请选择含“启动创作台.cmd”的目录。' }
    Assert-Unlinked $RootPath
    $distribution = Read-JsonFile (Join-Path $RootPath 'config/distribution.json')
    $currentVersion = Version-Value $distribution.version
    $repository = if ($distribution.updateRepositoryUrl) { [string]$distribution.updateRepositoryUrl } else { $defaultRepository }
    if ($repository -notmatch '^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$') { throw '更新仓库地址无效。' }
    $owner = $Matches[1]; $repoName = $Matches[2]
    $repository = "https://github.com/$owner/$repoName"
    $commit = $null
    if ($LocalUpdatePath) {
        $LocalUpdatePath = [IO.Path]::GetFullPath($LocalUpdatePath)
        $manifest = Read-JsonFile (Join-Path $LocalUpdatePath 'update-manifest.json')
    } else {
        if (-not $CheckOnly) { Write-Host '正在检查 GitHub 更新…' }
        $downloadRef = 'main'
        try {
            $reference = Invoke-RestMethod -Uri "https://api.github.com/repos/$owner/$repoName/git/ref/heads/main" -Headers $headers -TimeoutSec 20
            $commit = [string]$reference.object.sha
            if ($commit -notmatch '^[a-f0-9]{40}$') { throw '无法确定更新版本。' }
            $downloadRef = $commit
        } catch { $commit = $null }
        try {
            # A rate-limited GitHub API must not block public raw downloads.
            # Every payload still has to match this one manifest before applying.
            $manifestResponse = Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$owner/$repoName/$downloadRef/update-manifest.json" -Headers $headers -UseBasicParsing -TimeoutSec 30
            $manifest = [Text.Encoding]::UTF8.GetString($manifestResponse.RawContentStream.ToArray()) | ConvertFrom-Json
        } catch { throw '无法连接 GitHub 更新仓库。可在仓库页面下载更新，解压后运行“安装或更新.cmd”。' }
    }
    if ($manifest.formatVersion -ne 1 -or $manifest.mode -ne 'cumulative-file-overlay' -or $manifest.payloadDirectory -ne '更新文件' -or @($manifest.files).Count -lt 1 -or @($manifest.files).Count -gt 1000) { throw '更新清单格式不受支持。' }
    $latestVersion = Version-Value $manifest.version
    $minimumVersion = Version-Value $manifest.minimumFullVersion
    $seen = @{}; $totalBytes = [long]0
    foreach ($entry in $manifest.files) {
        Assert-PayloadPath $entry.path
        if ($seen.ContainsKey($entry.path) -or [long]$entry.bytes -lt 0 -or [long]$entry.bytes -gt 100MB -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw '更新清单包含重复项或无效文件。' }
        $seen[$entry.path] = $true; $totalBytes += [long]$entry.bytes
    }
    if ($totalBytes -ne [long]$manifest.totalBytes -or $totalBytes -gt 256MB -or -not $seen.ContainsKey('config/distribution.json')) { throw '更新清单总大小或版本配置不正确。' }
    $runtimeCatalog = Read-JsonFile (Join-Path $RootPath 'config/runtime-catalog.json')
    $compatible = $currentVersion -ge $minimumVersion -and $runtimeCatalog.packageId -eq $manifest.requiredRuntimePackageId
    $available = $latestVersion -gt $currentVersion
    $check = [ordered]@{ currentVersion=$distribution.version; latestVersion=$manifest.version; updateAvailable=$available; compatible=$compatible; repositoryUrl=$repository; commit=$commit; totalBytes=$totalBytes; fullPackageUrl=$distribution.fullPackageUrl }
    if ($CheckOnly) { $check | ConvertTo-Json -Compress; return }
    Write-Host "当前版本：$($distribution.version)    仓库版本：$($manifest.version)"
    if (-not $compatible) { throw "本次更新需要新的完整整合包：$($distribution.fullPackageUrl)" }
    if (-not $available) { Write-Host '已经是最新版本，无需更新。'; return }
    if ($Interactive) {
        Write-Host ("更新大小：{0:N2} MiB。会备份被替换的程序文件，保留模型、环境和个人数据。" -f ($totalBytes / 1MB))
        if ((Read-Host '更新并重启？输入 Y 继续') -notmatch '^[yY]$') { Write-Host '已取消。'; return }
    } elseif (-not $Apply) { throw '请使用 -Apply 或交互方式确认更新。' }
    $local = Safe-Child $RootPath '.local'
    New-Item -ItemType Directory -Path $local -Force | Out-Null
    $lockPath = Safe-Child $local 'update.lock'
    try { $updateLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw '已有更新任务正在运行，请等待完成。' }
    $stage = Safe-Child $local ('update-download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    $prepared = [Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($entry in $manifest.files) {
        $index++
        Write-Host "准备更新文件 $index/$(@($manifest.files).Count)：$($entry.path)"
        $stagedFile = Safe-Child $stage $entry.path
        $target = Safe-Child $RootPath $entry.path
        if (Test-Path -LiteralPath $target -PathType Container) { throw '更新目标存在同名文件夹。' }
        New-Item -ItemType Directory -Path (Split-Path -Parent $stagedFile) -Force | Out-Null
        if (File-Matches $target $entry) {
            Copy-Item -LiteralPath $target -Destination $stagedFile
        } elseif ($LocalUpdatePath) {
            $source = Safe-Child (Join-Path $LocalUpdatePath '更新文件') $entry.path
            Copy-Item -LiteralPath $source -Destination $stagedFile
        } else {
            $encoded = (($manifest.payloadDirectory + '/' + $entry.path).Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
            $downloaded = $false
            for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt++) {
                try { Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$owner/$repoName/$downloadRef/$encoded" -Headers $headers -UseBasicParsing -TimeoutSec 60 -OutFile $stagedFile; $downloaded = $true }
                catch { if ($attempt -eq 3) { throw '更新下载中断，原程序未被修改。请重试或使用仓库下载的离线更新。' }; Start-Sleep -Seconds $attempt }
            }
        }
        if (-not (File-Matches $stagedFile $entry)) { throw "更新文件校验失败，原程序未被修改：$($entry.path)" }
        $prepared.Add([pscustomobject]@{entry=$entry; staged=$stagedFile; target=$target})
    }
    $newDistribution = Read-JsonFile (Safe-Child $stage 'config/distribution.json')
    if ($newDistribution.version -ne $manifest.version -or $newDistribution.runtimePackageId -ne $manifest.requiredRuntimePackageId -or $newDistribution.mode -ne 'integrated' -or $newDistribution.updateRepositoryUrl.TrimEnd('/') -ne $repository) { throw '更新文件中的版本或仓库绑定不正确，原程序未被修改。' }
    # Stop only the service whose health identity matches this installation.
    $recordPath = Join-Path $local 'server-instance.json'
    if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
        $instance = Read-JsonFile $recordPath
        $serverPort = [int]$instance.port
        if ($serverPort -lt 1024 -or $serverPort -gt 65535) { throw '本机服务记录中的端口无效。' }
        $base = "http://127.0.0.1:$serverPort"
        $health = $null
        try { $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 3 } catch {}
        if (-not $health -and (Get-Process -Id $instance.pid -ErrorAction SilentlyContinue)) { throw '程序仍在运行但无法确认服务身份，请先使用“停止创作台.cmd”关闭后再更新。' }
        if ($health) {
            if ($health.projectRoot -ne $RootPath -or $health.pid -ne $instance.pid) { throw '服务身份不匹配，请先手动关闭此整合包。' }
            $idleConfirmed = $false
            $legacySetupConflict = $false
            try { $idleConfirmed = [bool](Invoke-RestMethod -Uri "$base/api/idle" -TimeoutSec 5).idle }
            catch {
                # Old studio gateways proxy /api/idle and return 409 before a
                # mode has been selected. Their shutdown endpoint still checks
                # all runtime/download work itself before allowing a stop.
                $response = $_.Exception.Response
                $unconfiguredStudio = $health.edition -eq 'studio' -and ($health.PSObject.Properties.Name -contains 'mode') -and $null -eq $health.mode
                if ($unconfiguredStudio -and $response -and [int]$response.StatusCode -eq 409) {
                    $legacySetupConflict = $true
                    Write-Host '旧版程序停在首次安装页，正在通过安全关闭接口确认状态…'
                } else { throw '无法确认程序是否空闲，请先运行“停止创作台.cmd”，确认停止后再重新更新。原程序尚未修改。' }
            }
            if (-not $idleConfirmed -and -not $legacySetupConflict) { throw '当前有生成或下载任务，请完成后再更新。' }
            try { $shutdown = Invoke-RestMethod -Uri "$base/api/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 30 }
            catch { throw '程序尚未安全停止，可能仍有生成、下载或安装任务。请等待任务结束，再运行“停止创作台.cmd”后重新更新。原程序尚未修改。' }
            if (-not $shutdown.stopping) { throw '服务未确认关闭，更新尚未应用。' }
            $stoppedService = $true
            for ($wait = 0; $wait -lt 100; $wait++) { if (-not (Get-Process -Id $health.pid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 200 }
            if (Get-Process -Id $health.pid -ErrorAction SilentlyContinue) { throw '服务仍在退出，更新尚未应用，请稍后重试。' }
        }
    }
    $backupRoot = Safe-Child $local ('update-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $backupRoot | Out-Null
    foreach ($item in $prepared) {
        if (File-Matches $item.target $item.entry) { continue }
        $exists = Test-Path -LiteralPath $item.target -PathType Leaf
        $backupFile = Safe-Child $backupRoot $item.entry.path
        if ($exists) { New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null; Copy-Item -LiteralPath $item.target -Destination $backupFile }
        $changed.Add([pscustomobject]@{path=$item.entry.path; existed=$exists; backup=$backupFile; target=$item.target})
        Write-JsonFile (Join-Path $backupRoot 'journal.json') @($changed.ToArray())
        New-Item -ItemType Directory -Path (Split-Path -Parent $item.target) -Force | Out-Null
        Copy-Item -LiteralPath $item.staged -Destination $item.target -Force
        if (-not (File-Matches $item.target $item.entry)) { throw '应用后的文件校验失败，正在恢复原程序。' }
    }
    if ($Restart) { $restartAttempted = $true; Restart-Studio }
    Write-JsonFile (Join-Path $local 'last-update.json') @{status='completed';fromVersion=$distribution.version;version=$manifest.version;repositoryUrl=$repository;commit=$commit;backup=$backupRoot;completedAt=(Get-Date).ToString('o')}
    Write-Host "更新完成：$($manifest.version)。备份位置：$backupRoot"
} catch {
    $failure = $_.Exception.Message
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    for ($index = $changed.Count - 1; $index -ge 0; $index--) {
        $item = $changed[$index]
        try {
            Assert-PayloadPath $item.path
            $target = Safe-Child $RootPath $item.path
            if ($item.existed) { Copy-Item -LiteralPath $item.backup -Destination $target -Force }
            elseif (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
        } catch { $rollbackErrors.Add($item.path) }
    }
    if (($stoppedService -or $restartAttempted) -and $Restart -and $rollbackErrors.Count -eq 0) { try { Restart-Studio } catch {} }
    if ($rollbackErrors.Count) { [Console]::Error.WriteLine("更新未完成，部分文件需要从备份恢复：$backupRoot") }
    elseif ($changed.Count) { [Console]::Error.WriteLine('更新未完成，已恢复原程序。') }
    [Console]::Error.WriteLine($failure)
    exit 1
} finally {
    if ($updateLock) { $updateLock.Dispose() }
}
