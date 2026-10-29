param([int]$Seconds = 8)
$ErrorActionPreference = "SilentlyContinue"
if (-not ("NapConsoleHide" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NapConsoleHide {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
}
$deadline = (Get-Date).AddSeconds([Math]::Max(1, $Seconds))
do {
  $script:owned = @{}
  Get-Process -Name QQ, NapCatWinBootMain -ErrorAction SilentlyContinue | ForEach-Object { $script:owned[[uint32]$_.Id] = $true }
  if ($script:owned.Count -gt 0) {
    $callback = {
      param($hwnd, $lparam)
      $procId = [uint32]0
      [void][NapConsoleHide]::GetWindowThreadProcessId($hwnd, [ref]$procId)
      if (-not $script:owned.ContainsKey($procId)) { return $true }
      $name = New-Object System.Text.StringBuilder 64
      [void][NapConsoleHide]::GetClassName($hwnd, $name, $name.Capacity)
      if ($name.ToString() -eq "ConsoleWindowClass" -and [NapConsoleHide]::IsWindowVisible($hwnd)) {
        [void][NapConsoleHide]::ShowWindow($hwnd, 0)
      }
      return $true
    }
    [NapConsoleHide]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  }
  Start-Sleep -Milliseconds 400
} while ((Get-Date) -lt $deadline)
