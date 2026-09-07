# 登录自启入口（计划任务 CampusConsole-Autostart 调用，隐藏窗口）
$RepoDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
try { $node = Ensure-Node -RepoDir $RepoDir } catch { exit 1 }
& $node (Join-Path $RepoDir 'src\cli.mjs') ui --no-open
