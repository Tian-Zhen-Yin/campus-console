# 前台启动台账服务（关闭本窗口即停止）；登录自启走 autostart.ps1
$RepoDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Ensure-Node -RepoDir $RepoDir
Write-Host '台账：http://127.0.0.1:7788/  （关闭本窗口即停止服务）'
Start-Process 'http://127.0.0.1:7788/'
& $node (Join-Path $RepoDir 'src\cli.mjs') ui
