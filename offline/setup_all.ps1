$ErrorActionPreference = "Stop"

# arguments:
# - installdir: The directory where the AI Playground is installed
# - envs: A space-separated list of environments to set up (e.g., "ai-backend ov comfyui llamacpp")
# -       If no envs are specified, all environments will be set up
# example usage:
#   .\setup_all.ps1 installdir="C:\path\to\install" envs="ai-backend comfyui"

# Get the directory of the current script file
$scriptDir = $PSScriptRoot
$installDir = "$HOME\AppData\Local\Programs\AI Playground"
$envsToSetup = @("ai-backend", "ov", "comfyui", "llamacpp")


# Parse arguments
foreach ($arg in $args) {
    if ($arg -match "^installdir=(.+)$") {
        $installDir = $matches[1]
    }
    elseif ($arg -match '^envs="(.*)"$' -or $arg -match "^envs='(.*)'$" -or $arg -match "^envs=(.*)$") {
        $envsToSetup = $matches[1] -split '\s+' | Where-Object { $_ -ne "" }
    }
}

Write-Host "Install directory: $installDir"
Write-Host "Environments to set up: $($envsToSetup -join ', ')"

# Check if the install directory exists
if (-not (Test-Path $installDir)) {
    Write-Host "Install directory does not exist: $installDir"
    exit 1
}

# Map environment names to their setup script names
$envScriptMap = @{
    "ai-backend" = "setup_ai-backend-env.ps1"
    "ov" = "setup_ov-env.ps1"
    "comfyui" = "setup_comfyui-env.ps1"
    "llamacpp" = "setup_llamacpp-env.ps1"
}

# Run the required setup scripts
foreach ($env in $envsToSetup) {
    $scriptName = $envScriptMap[$env]
    if ($scriptName) {
        Write-Host "Setting up $env environment..."
        $scriptPath = Join-Path $scriptDir $scriptName
        
        Write-Host "Running script: $scriptPath"
        & $scriptPath "$installDir"
        # check if the script ran successfully
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Error: Failed to set up $env environment."
            exit 1
        }
        Write-Host "$env environment setup completed."

    }
    else {
        Write-Host "Warning: Unknown environment '$env', skipping"
    }
}

function Kill-Git-Process {
    # kill git.exe process$gitProcess = Get-Process -Name git -ErrorAction SilentlyContinue
    $gitProcess = Get-Process -Name git -ErrorAction SilentlyContinue
    if ($gitProcess) {
        $gitProcess | Stop-Process -Force
    }   
}

Kill-Git-Process