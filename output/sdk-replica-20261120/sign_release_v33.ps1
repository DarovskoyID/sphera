$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SphereDpapiV30 {
  [StructLayout(LayoutKind.Sequential)] public struct BLOB { public int size; public IntPtr data; }
  [DllImport("crypt32.dll", SetLastError=true)] public static extern bool CryptUnprotectData(ref BLOB input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out BLOB output);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
}
'@
$keyPath=(Resolve-Path 'D:\sphere-all\.release-private\server-release-20261117.dpapi').Path
$payloadPath='D:\sphere-all\output\sdk-replica-20261120\sdk-enable-v33-sign-payload.json'
$outputPath='D:\sphere-all\output\sdk-replica-20261120\sdk-enable-v33.json'
$keyBytes=[IO.File]::ReadAllBytes($keyPath); $inputPtr=[Runtime.InteropServices.Marshal]::AllocHGlobal($keyBytes.Length); $output=New-Object SphereDpapiV30+BLOB
try {
  [Runtime.InteropServices.Marshal]::Copy($keyBytes,0,$inputPtr,$keyBytes.Length)
  $input=New-Object SphereDpapiV30+BLOB; $input.size=$keyBytes.Length; $input.data=$inputPtr
  if(-not [SphereDpapiV30]::CryptUnprotectData([ref]$input,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,1,[ref]$output)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
  $der=New-Object byte[] $output.size; [Runtime.InteropServices.Marshal]::Copy($output.data,$der,0,$output.size)
  $start=New-Object Diagnostics.ProcessStartInfo; $start.FileName=(Get-Command node).Source; $start.Arguments='"D:\sphere-all\output\sdk-replica-20261120\sign_release_v33.cjs"'; $start.UseShellExecute=$false; $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  $process=[Diagnostics.Process]::Start($start); $process.StandardInput.WriteLine([Convert]::ToBase64String($der)); $process.StandardInput.WriteLine([Convert]::ToBase64String([IO.File]::ReadAllBytes($payloadPath))); $process.StandardInput.Close()
  $stdout=$process.StandardOutput.ReadToEnd(); $stderr=$process.StandardError.ReadToEnd(); $process.WaitForExit(); if($process.ExitCode -ne 0){throw "Signer failed: $stderr"}
  $document=$stdout.Trim() | ConvertFrom-Json; $certificate=Get-Content 'D:\sphere-all\release\delegations\server-release-20261117.json' -Raw | ConvertFrom-Json
  $outer=[ordered]@{certificate=$certificate;document=$document}|ConvertTo-Json -Depth 20 -Compress
  [IO.File]::WriteAllText($outputPath,$outer,(New-Object System.Text.UTF8Encoding($false)))
  $der.Initialize(); $keyBytes.Initialize()
} finally {
  $zeroes=New-Object byte[] $keyBytes.Length; [Runtime.InteropServices.Marshal]::Copy($zeroes,0,$inputPtr,$zeroes.Length); [Runtime.InteropServices.Marshal]::FreeHGlobal($inputPtr)
  if($output.data -ne [IntPtr]::Zero){[SphereDpapiV30]::LocalFree($output.data)|Out-Null}
}
Write-Output 'Signed v33 update manifest with locally protected publisher key.'
