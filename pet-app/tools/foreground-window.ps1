# foreground-window.ps1 —— 读一次「当前前台窗口」的进程名 + 窗口标题。
#
# 被 src/main/pi-companion.ts 用 child_process.execFile 调一次，用 -File 传路径，
# 所以命令行里不会被拼进任何外部输入（没有命令注入面）。
#
# 输出约定（两行，UTF-8 无 BOM）：
#   第 1 行 = 进程名（例如 chrome）
#   第 2 行起 = 窗口标题原文（可能含换行）
# 任何异常都走 exit 1 + 空输出 —— 上层看到失败就静默跳过这次采样。
#
# ⚠️ 标题是敏感数据：它只会被 Node 侧的分类器读一遍，然后丢进内存、
#    由 classifyActivity 变成闭集标签。这个脚本自己不写任何文件、不打印日志。

$ErrorActionPreference = 'Stop'

# 必须先把输出编码钉成 UTF-8：Windows PowerShell 5.1 在 stdout 被重定向时
# 默认用控制台代码页（中文系统是 GBK），中文标题会被 Node 侧按 UTF-8 解出乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

try {
    Add-Type -Namespace SiPet -Name Win32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();

[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern int GetWindowTextLengthW(System.IntPtr hWnd);

[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
'@

    $hwnd = [SiPet.Win32]::GetForegroundWindow()
    if ($hwnd -eq [System.IntPtr]::Zero) { exit 1 }

    # GetWindowTextLengthW 是"不含结尾 NUL 的字符数"，+1 给 NUL 留位
    $length = [SiPet.Win32]::GetWindowTextLengthW($hwnd)
    $title = ''
    if ($length -gt 0) {
        $buffer = New-Object System.Text.StringBuilder ($length + 1)
        [void][SiPet.Win32]::GetWindowTextW($hwnd, $buffer, $buffer.Capacity)
        $title = $buffer.ToString()
    }

    $processId = 0
    [void][SiPet.Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId)
    if ($processId -eq 0) { exit 1 }

    $processName = (Get-Process -Id $processId -ErrorAction 'Stop').ProcessName
    if ([string]::IsNullOrWhiteSpace($processName)) { exit 1 }

    Write-Output $processName
    Write-Output $title
} catch {
    exit 1
}
