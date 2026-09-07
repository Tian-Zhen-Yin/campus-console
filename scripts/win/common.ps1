# 公共函数：确保便携版 Node 就绪（首次自动从 nodejs.org 下载到包内 runtime\，免管理员）
# 用法：在 install.ps1 / start.ps1 中 dot-source 本文件后调用 Ensure-Node
function Ensure-Node {
    param([string]$RepoDir)
    $runtime = Join-Path $RepoDir 'runtime\node'
    if (Test-Path (Join-Path $runtime 'node.exe')) { return (Join-Path $runtime 'node.exe') }

    $version = 'v22.14.0'
    $zipName = "node-$version-win-x64.zip"
    $url = "https://nodejs.org/dist/$version/$zipName"
    Write-Host "▸ 首次运行：下载便携版 Node（约 30 MB，来自 nodejs.org 官方地址）……"
    $tmpZip = Join-Path $env:TEMP $zipName
    curl.exe -fsSL $url -o $tmpZip
    if (-not (Test-Path $tmpZip)) { throw 'Node 下载失败，请检查网络后重试' }

    Write-Host '▸ 解压运行时……'
    $tmpExtract = Join-Path $env:TEMP ("node-extract-" + [guid]::NewGuid().ToString('N'))
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Copy-Item -Path (Join-Path $tmpExtract "node-$version-win-x64\*") -Destination $runtime -Recurse -Force
    Remove-Item -Recurse -Force $tmpExtract, $tmpZip -ErrorAction SilentlyContinue

    if (-not (Test-Path (Join-Path $runtime 'node.exe'))) { throw 'Node 运行时解压失败' }
    Write-Host '  ✓ 运行时就绪'
    return (Join-Path $runtime 'node.exe')
}
