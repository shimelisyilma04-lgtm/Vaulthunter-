param(
  [switch]$Continuous
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Host "Node.js 20 or newer is required. Install the LTS release from https://nodejs.org/ and reopen PowerShell."
  exit 1
}

$nodeVersionText = (& node --version).Trim().TrimStart("v")
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion.Major -lt 20) {
  Write-Host "Detected Node.js $nodeVersionText. Please install Node.js 20 or newer from https://nodejs.org/."
  exit 1
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created local .env from .env.example. It is excluded from Git."
}

$envLines = @(Get-Content ".env")
$rpcIndex = -1
for ($i = 0; $i -lt $envLines.Count; $i++) {
  if ($envLines[$i] -match '^\s*ETHEREUM_RPC_URL\s*=') {
    $rpcIndex = $i
    break
  }
}

$rpcValue = ""
if ($rpcIndex -ge 0) {
  $rpcValue = ($envLines[$rpcIndex] -replace '^\s*ETHEREUM_RPC_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
}

if ([string]::IsNullOrWhiteSpace($rpcValue)) {
  $rpcValue = Read-Host "Paste your Ethereum Mainnet RPC HTTPS endpoint (input is saved only in your local .env)"
  $parsedUri = $null
  if (-not [uri]::TryCreate($rpcValue, [System.UriKind]::Absolute, [ref]$parsedUri) -or
      ($parsedUri.Scheme -ne "https" -and $parsedUri.Scheme -ne "http")) {
    throw "That does not look like a valid HTTP(S) RPC URL. Nothing was started."
  }

  $newLine = "ETHEREUM_RPC_URL=$rpcValue"
  if ($rpcIndex -ge 0) {
    $envLines[$rpcIndex] = $newLine
  } else {
    $envLines += $newLine
  }
  [System.IO.File]::WriteAllText(
    (Join-Path (Get-Location) ".env"),
    (($envLines -join [Environment]::NewLine) + [Environment]::NewLine),
    (New-Object System.Text.UTF8Encoding($false))
  )
}

Write-Host "Installing project dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

Write-Host "Running a read-only Aave V3 indexer pass. No wallet or transaction signing is used."
if ($Continuous) {
  npm run aave:index
} else {
  npm run aave:index:once
}
if ($LASTEXITCODE -ne 0) { throw "The indexer exited with an error. Review the message above." }
