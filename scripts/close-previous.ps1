# close-previous.ps1 -- called by scripts/dev.js before every start.
#
# Leaves no earlier G-code Studio behind:
#   1. browser processes that use the app's PRIVATE profile directory are
#      stopped -- that profile is only ever used by the app window, so this
#      never touches the user's own browsing
#   2. any remaining visible window titled exactly "G-code Studio" gets a normal
#      close (WM_CLOSE) -- this catches windows opened before the private
#      profile existed, which live inside the user's shared Edge process and
#      must be closed, not killed
#   3. whatever still listens on the app's ports is stopped
param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$Ports = '5173,5174',   # comma list; -File passes arrays as one string
  [int]$Keep = 0
)
$ErrorActionPreference = 'SilentlyContinue'

Get-CimInstance Win32_Process |
  Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($Profile) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class GcsWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int CloseByTitle(string title) {
    int n = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++; }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
[void][GcsWin]::CloseByTitle('G-code Studio')

foreach ($p in ($Ports -split ',' | ForEach-Object { [int]$_.Trim() })) {
  Get-NetTCPConnection -LocalPort $p -State Listen |
    ForEach-Object { if ($_.OwningProcess -ne $Keep) { Stop-Process -Id $_.OwningProcess -Force } }
}
