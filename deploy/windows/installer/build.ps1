# Builds the Windows installer: dist-installer\HoudiniDeck-Setup-<version>.exe.
# Needs Node.js 24 (this node.exe goes into the installer) and Inno Setup 6
# (winget install JRSoftware.InnoSetup). CI runs it in .github/workflows/windows-installer.yml.
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$out = Join-Path $root 'dist-installer'
$stage = Join-Path $out 'stage'
$app = Join-Path $stage 'app'

function Invoke-Checked([string]$what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE) { throw "$what failed (exit code $LASTEXITCODE)" }
}

$nodeVersion = (node --version).TrimStart('v')
if ([int]$nodeVersion.Split('.')[0] -lt 24) { throw "Node.js $nodeVersion would go into the installer; use Node.js 24 or newer" }
$iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 is missing: winget install JRSoftware.InnoSetup' }

Push-Location $root
try {
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  if ($env:GITHUB_REF_TYPE -eq 'tag' -and $env:GITHUB_REF_NAME -ne "v$version") {
    throw "The tag $env:GITHUB_REF_NAME doesn't match the version in package.json ($version)"
  }
  Invoke-Checked 'npm ci' { npm ci --no-audit --no-fund }
  Invoke-Checked 'npm run build' { npm run build }

  # What the installed deck runs: the server, the built web UI, and only its run-time packages.
  if (Test-Path $out) { Remove-Item $out -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $app 'web') -Force | Out-Null
  Copy-Item server, shared -Destination $app -Recurse
  Copy-Item package.json, package-lock.json, LICENSE, README.md -Destination $app
  Copy-Item web\dist -Destination (Join-Path $app 'web') -Recurse
  Push-Location $app
  try {
    Invoke-Checked 'npm ci --omit=dev' { npm ci --omit=dev --ignore-scripts --no-audit --no-fund }
  } finally {
    Pop-Location
  }

  # Node.js itself, with its license.
  $node = (Get-Command node).Source
  Copy-Item $node (Join-Path $stage 'node.exe')
  $nodeLicense = Join-Path (Split-Path $node) 'LICENSE'
  if (Test-Path $nodeLicense) { Copy-Item $nodeLicense (Join-Path $stage 'node-LICENSE.txt') }

  Invoke-Checked 'Inno Setup' { & $iscc /Q "/DAppVersion=$version" "/DStageDir=$stage" "/DOutputDir=$out" (Join-Path $PSScriptRoot 'installer.iss') }
  Write-Host "Built $(Join-Path $out "HoudiniDeck-Setup-$version.exe") (Node.js $nodeVersion inside)"
} finally {
  Pop-Location
}
