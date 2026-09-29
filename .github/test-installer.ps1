# CI: tries the built Windows installer on the runner. Installs it silently with every option, runs the
# deck the way the shortcuts do (against the mock OBS), updates over the running deck, lets the deck
# update itself (update-test.mjs), then uninstalls it and checks that everything is gone.
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$setup = Get-ChildItem (Join-Path $root 'dist-installer\HoudiniDeck-Setup-*.exe') | Select-Object -First 1
if (-not $setup) { throw 'No installer was built' }
$app = Join-Path $env:ProgramFiles 'HoudiniDeck'
$data = Join-Path $env:LOCALAPPDATA 'HoudiniDeck'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'HoudiniDeck.lnk'
$startMenu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'HoudiniDeck.lnk'
$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{ED93638B-60CA-42FE-852B-8032525DB212}_is1'
$log = Join-Path $root 'dist-installer\install.log'

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAILED: $message" }
  Write-Host "ok: $message"
}
function Get-FirewallRuleCount {
  $rules = netsh advfirewall firewall show rule name=HoudiniDeck 2>$null
  if ($LASTEXITCODE -ne 0) { return 0 }
  @($rules | Select-String '^Rule Name:').Count
}
function Get-Health {
  try { Invoke-RestMethod http://127.0.0.1:3398/api/health -TimeoutSec 2 } catch { $null }
}
function Wait-Until([scriptblock]$condition, [string]$what, [int]$seconds = 60) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for $what"
}
function Install([string]$tasks) {
  $p = Start-Process $setup.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/TASKS=$tasks", "/LOG=$log" -Wait -PassThru
  if ($p.ExitCode -ne 0) {
    Get-Content $log
    throw "Setup exited with $($p.ExitCode)"
  }
}
function Start-Deck { Start-Process (Join-Path $app 'HoudiniDeck.cmd') -WindowStyle Hidden }

Write-Host "Installing $($setup.Name) ($([math]::Round($setup.Length / 1MB)) MB)"
Install 'firewall,autostart,desktopicon'
Assert (Test-Path "$app\node.exe") 'Node.js is installed with it'
Assert (Test-Path "$app\app\server\index.ts") 'the server is installed'
Assert (Test-Path "$app\app\web\dist\index.html") 'the web UI is installed'
Assert (Test-Path "$app\app\node_modules\fastify") 'its packages are installed'
Assert (-not (Test-Path "$app\app\node_modules\vite")) 'development packages are left out'
Assert (Test-Path $startMenu) 'Start menu shortcut'
Assert (Test-Path $startup) 'autostart shortcut'
Assert ((Get-FirewallRuleCount) -eq 1) 'firewall rule'
Assert ($null -ne (Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue)) 'listed in Apps'

# Run it the way the shortcuts do; the .env in the data folder points it at the mock OBS, and at the
# made-up release update-test.mjs serves.
New-Item -ItemType Directory -Force $data | Out-Null
Set-Content (Join-Path $data '.env') "PORT=3398`nOBS_URL=ws://127.0.0.1:4456`nOBS_PASSWORD=`nSTREAMDECK_UPDATE_FEED=http://127.0.0.1:3390/latest"
$mock = Start-Process node -ArgumentList 'server/dev/mock-obs.ts' -WorkingDirectory $root -WindowStyle Hidden -PassThru
try {
  Start-Deck
  Wait-Until { (Get-Health).obs -eq 'connected' } 'the installed deck to reach the mock OBS'
  Assert ((Invoke-WebRequest http://127.0.0.1:3398/ -UseBasicParsing).Content -match '<div id="app"') 'the installed deck serves its UI'
  Assert (Test-Path "$data\deck.json") 'it keeps its deck in %LOCALAPPDATA%\HoudiniDeck'

  Install 'firewall'
  Assert ($null -eq (Get-Health)) 'an update stops the running deck first'
  Assert (Test-Path "$data\deck.json") 'an update keeps the deck'
  Assert ((Get-FirewallRuleCount) -eq 1) 'the firewall rule is still there, just once'

  Start-Deck
  Wait-Until { Get-Health } 'the updated deck to start'

  Write-Host 'Letting the deck update itself (Update now, from the PC)'
  & node (Join-Path $root '.github\update-test.mjs') --installer $setup.FullName --port 3398
  $updated = $LASTEXITCODE -eq 0
  if (-not $updated -and (Test-Path "$data\updates\install.log")) { Get-Content "$data\updates\install.log" }
  Assert $updated 'the deck downloads the installer, runs it silently, and is started again by it'
  Assert (Test-Path "$data\updates\install.log") 'the installer wrote its log into the data folder'
  Assert (Test-Path "$data\deck.json") 'the self-update keeps the deck'
  Write-Host 'Uninstalling (with /PURGEDATA)'
  & "$app\unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /PURGEDATA
  # The uninstaller hands over to a copy of itself and returns at once, so wait for the folder to go.
  Wait-Until { -not (Test-Path $app) } 'the program folder to be removed' 120
  Wait-Until { -not (Test-Path $data) } 'the data folder to be removed (/PURGEDATA)' 30
  Assert ($null -eq (Get-Health)) 'uninstalling stopped the deck'
  Assert ((Get-FirewallRuleCount) -eq 0) 'the firewall rule is removed'
  Assert (-not (Test-Path $startMenu)) 'the Start menu shortcut is removed'
  Assert (-not (Test-Path $startup)) 'the autostart shortcut is removed'
  Assert ($null -eq (Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue)) 'gone from Apps'
} finally {
  Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
}
Write-Host 'The installer and uninstaller work.'
# The last netsh (no such rule, as it should be) left exit code 1 behind.
exit 0
