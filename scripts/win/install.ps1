# 秋招校招投递管理 · Windows 安装
# 功能：确保运行时 → 注册开机自启与定时任务 → 启动服务并打开台账
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$RepoDir = Split-Path -Parent $PSScriptRoot   # scripts\.. = ats-status
. (Join-Path $PSScriptRoot 'common.ps1')

Write-Host '━━━ 校招投递管理 · 完整版安装（Windows）━━━'
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Write-Host '✗ 未找到 curl.exe（Windows 10/11 自带）'; exit 1 }

Write-Host '▸ 准备运行时（便携版 Node）……'
if ($DryRun) { Write-Host '  [dry-run] Ensure-Node' } else { $null = Ensure-Node -RepoDir $RepoDir }

$scheduleTasks = @(
    @('CampusSchedule-0930', '09:30'),
    @('CampusSchedule-1430', '14:30'),
    @('CampusSchedule-2000', '20:00')
)

if ($DryRun) {
    Write-Host '━━━ dry-run 结束：以下为将注册的计划任务 ━━━'
    Write-Host '  CampusConsole-Autostart（登录自启）'
    $scheduleTasks | ForEach-Object { Write-Host ("  {0}（工作日 {1} 查询+检查邮箱）" -f $_[0], $_[1]) }
    exit 0
}

Write-Host '▸ 注册开机自启（登录后自动运行台账服务）……'
$autostart = Join-Path $PSScriptRoot 'autostart.ps1'
schtasks /Create /F /TN 'CampusConsole-Autostart' /SC ONLOGON /RL LIMITED /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$autostart`"" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host '  ⚠ 自启任务注册失败（可稍后在 .bat 里重试），继续其余步骤' }

Write-Host '▸ 注册定时查询（工作日 9:30 / 14:30 / 20:00）……'
foreach ($t in $scheduleTasks) {
    schtasks /Create /F /TN $t[0] /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST $t[1] /TR "curl.exe -s -X POST http://127.0.0.1:7788/api/status --max-time 600" | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host ("  ✓ {0}" -f $t[0]) } else { Write-Host ("  ⚠ {0} 注册失败" -f $t[0]) }
}

Write-Host '▸ 启动服务……'
$node = Ensure-Node -RepoDir $RepoDir
Start-Process -FilePath $node -ArgumentList 'src/cli.mjs', 'ui', '--no-open' -WorkingDirectory $RepoDir -WindowStyle Hidden
$ok = $false
foreach ($i in 1..15) {
    try { Invoke-WebRequest -Uri 'http://127.0.0.1:7788/api/state' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $ok) { Write-Host '✗ 服务未响应，请查看 runtime 日志'; exit 1 }

Start-Process 'http://127.0.0.1:7788/'
Write-Host '━━━ 安装完成 ━━━'
Write-Host '  台账（日常用）      http://127.0.0.1:7788/'
Write-Host '  控制台（偶尔维护）  http://127.0.0.1:7788/console/'
Write-Host '  下一步：在台账「自动跟进」里接入你投过的公司（扫码一次即可）'
