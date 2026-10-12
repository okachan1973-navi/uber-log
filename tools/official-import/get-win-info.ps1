param([int]$Port = 9223)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WinInfoDefault {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumDesktopDelegate lpfn, IntPtr lParam);
    public delegate bool EnumDesktopDelegate(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);
}
"@

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
    Write-Output "{}"
    exit
}

$targetPid = $conn.OwningProcess
$hDesk = [WinInfoDefault]::OpenDesktop("Default", 0, $false, 0x01FF)

$foundHwnd = 0
$foundTitle = ""
$foundVis = $false

if ($hDesk -ne [IntPtr]::Zero) {
    [WinInfoDefault]::EnumDesktopWindows($hDesk, {
        param($hwnd, $lparam)
        $pidOut = 0
        [WinInfoDefault]::GetWindowThreadProcessId($hwnd, [ref]$pidOut) | Out-Null
        if ($pidOut -eq $targetPid) {
            $sb = New-Object System.Text.StringBuilder 512
            [WinInfoDefault]::GetWindowText($hwnd, $sb, 512) | Out-Null
            $t = $sb.ToString()
            $v = [WinInfoDefault]::IsWindowVisible($hwnd)
            if ($t.Length -gt 0 -and $t.Length -gt $foundTitle.Length) {
                $script:foundHwnd = $hwnd.ToInt64()
                $script:foundTitle = $t
                $script:foundVis = $v
            }
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    [WinInfoDefault]::CloseDesktop($hDesk) | Out-Null
}

$obj = @{
    pid = $targetPid
    mainWindowHandle = $foundHwnd
    title = $foundTitle
    isVisible = $foundVis
    desktop = 'WinSta0\Default'
}

Write-Output ($obj | ConvertTo-Json -Compress)
