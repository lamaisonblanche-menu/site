# Envoie des octets bruts (ESC/POS) a une imprimante Windows (USB) par le spouleur, sans pilote graphique.
param([string]$Printer, [string]$File)
$ErrorActionPreference = 'Stop'
if (-not ('RawPrintMB' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RawPrintMB {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)] static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static string Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "ERR introuvable";
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Caisse La Maison Blanche"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "ERR demarrage " + Marshal.GetLastWin32Error();
      StartPagePrinter(h);
      int w; bool ok = WritePrinter(h, data, data.Length, out w);
      EndPagePrinter(h); EndDocPrinter(h);
      return (ok && w == data.Length) ? "OK" : "ERR ecriture " + Marshal.GetLastWin32Error();
    } finally { ClosePrinter(h); }
  }
}
"@
}
Write-Output ([RawPrintMB]::Send($Printer, [IO.File]::ReadAllBytes($File)))
