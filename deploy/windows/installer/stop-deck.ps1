# Stops a HoudiniDeck that runs from this program folder (its Node.js and the window it runs in), so
# the installer can replace or remove the files. installer.iss runs it before updates and uninstalling.
param([Parameter(Mandatory = $true)] [string]$AppDir)

$node = Join-Path $AppDir 'node.exe'
$launcher = (Join-Path $AppDir 'HoudiniDeck.cmd').ToLowerInvariant()
$stopped = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -eq $node -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($launcher))
}
foreach ($process in $stopped) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
# Give Windows a moment to let go of the files.
if ($stopped) { Start-Sleep -Milliseconds 800 }
