# 卸载：删除计划任务；数据目录 %USERPROFILE%\.ats-status 手动删除即无残留
schtasks /Delete /TN 'CampusConsole-Autostart' /F 2>$null
schtasks /Delete /TN 'CampusSchedule-0930' /F 2>$null
schtasks /Delete /TN 'CampusSchedule-1430' /F 2>$null
schtasks /Delete /TN 'CampusSchedule-2000' /F 2>$null
Write-Host '计划任务已移除。如需彻底清理数据，请删除 %USERPROFILE%\.ats-status 文件夹（登录会话等都在里面）。'
