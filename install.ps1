# Cebus Installation Script
# Run: powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Installing Cebus..." -ForegroundColor Cyan
Write-Host ""

# Get the script directory
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Check for Node.js
Write-Host "  Checking Node.js..." -ForegroundColor Gray
$nodeVersion = $null
try {
    $nodeVersion = node --version 2>$null
} catch {}

if ($nodeVersion) {
    Write-Host "  [OK] Node.js $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "  [ERROR] Node.js not found. Please install Node.js first:" -ForegroundColor Red
    Write-Host "          https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Install npm dependencies (skip optional provider SDKs to keep install lean)
Write-Host "  Installing core dependencies..." -ForegroundColor Gray
Push-Location $installDir
try {
    npm install --omit=optional --silent 2>$null
    Write-Host "  [OK] Core dependencies installed" -ForegroundColor Green
} catch {
    Write-Host "  [ERROR] Failed to install dependencies: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}

# Build the project (prebuild script auto-installs rollup/esbuild Windows binaries)
Write-Host "  Building project..." -ForegroundColor Gray
try {
    npm run build
    Write-Host "  [OK] Build complete" -ForegroundColor Green
} catch {
    Write-Host "  [ERROR] Build failed: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}

# Link globally so 'cebus' command works from any directory
Write-Host "  Linking CLI globally..." -ForegroundColor Gray
try {
    npm link
    Write-Host "  [OK] 'cebus' command registered globally" -ForegroundColor Green
} catch {
    Write-Host "  [WARN] npm link failed. Try running as administrator." -ForegroundColor Yellow
}

Pop-Location

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Restart your terminal, then run:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    cebus config    # See which providers are available" -ForegroundColor White
Write-Host "    cebus           # Start chatting" -ForegroundColor White
Write-Host ""
Write-Host "  To add AI providers, install only the ones you need:" -ForegroundColor Gray
Write-Host "    npm install openai              # OpenAI + Ollama" -ForegroundColor Gray
Write-Host "    npm install @anthropic-ai/sdk   # Anthropic" -ForegroundColor Gray
Write-Host "    npm install @google/genai       # Google Gemini" -ForegroundColor Gray
Write-Host "    npm install @github/copilot-sdk # GitHub Copilot" -ForegroundColor Gray
Write-Host ""
