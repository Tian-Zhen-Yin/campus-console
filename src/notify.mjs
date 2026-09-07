import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOAST_PS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify-toast.ps1');

// 跨平台系统通知：macOS = osascript；Windows = WinRT toast（PowerShell，无第三方模块）；其它 = 打到控制台
export function notify(title, message = '') {
  try {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', `display notification ${JSON.stringify(String(message).replace(/"/g, "'"))} with title ${JSON.stringify(title)}`]);
    } else if (process.platform === 'win32') {
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST_PS, '-Title', title, '-Message', String(message)], { windowsHide: true });
    } else {
      console.log(`[notify] ${title}: ${message}`);
    }
  } catch (_) { /* 通知失败不影响主流程 */ }
}
