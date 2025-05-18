$ErrorActionPreference = "Stop"
$ProgressPreference = 'SilentlyContinue'

Write-Host "paramter size:" $args.Count

$scriptDir = $PSScriptRoot
$srcRootDir = (Get-Item $scriptDir).Parent.FullName
Write-Host "Root directory: $srcRootDir"

# create dir offline-resource
$offlineResourceDir = "$scriptDir\offline-resource"
$wheelsDir = "$offlineResourceDir\wheels"

# check if git.exe is working in current system
try {
    git --version | Out-Null
    Write-Host "git.exe is in PATH"
} catch {
    Write-Host "git.exe is not in PATH, please install Git for Windows first..."
    exit 1
}

$7zrPath = Join-Path $srcRootDir "build_resources\7zr.exe"
if (-not (Test-Path $7zrPath)) {
    $7zrPath = "$scriptDir\7zr.exe"
    if (-not (Test-Path $7zrPath)) {
        $7zrUrl = "https://www.7-zip.org/a/7zr.exe"
        Write-Host "Downloading 7zr.exe..."
        Invoke-WebRequest $7zrUrl -OutFile $7zrPath
        Write-Host "Downloaded 7zr.exe [done]"
    }
}
Write-Host "7zr.exe path: $7zrPath"


# get paramter like -conda_env_dir=...
$condaDir = "$HOME\miniforge3\envs\cp312_libuv"
if ($args.Count -gt 0) {
    foreach ($arg in $args) {
        if ($arg -match "^-conda_env_dir=(.+)$") {
            $condaDir = $Matches[1]
            break
        }
    }
}
Write-Host "Conda env dir: $condaDir"
$pythonPath = Join-Path $condaDir "python.exe"

# check if pythonPath exists
if (-not (Test-Path $pythonPath)) {
    Write-Host "Python path not found: $pythonPath"
    Write-Host "Please run command 'npm run fetch-build-resources -- --conda_env_dir=<path_to_cp312_libuv_conda_env>' first"
    exit 1
}
Write-Host "Python path: $pythonPath"

Write-Host "*********************************************************"

### functions ###
function Get-Version {
    # Read version from package.json
    $packageJsonPath = Join-Path (Split-Path -Parent $scriptDir) "WebUI\package.json"
    if (Test-Path $packageJsonPath) {
        try {
            $packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
            $version = $packageJson.version
            Write-Host "Detected version from package.json: $version"
        } catch {
            Write-Host "Error reading version from package.json, using default version"
            $version = "unknown"
        }
    } else {
        Write-Host "package.json not found at $packageJsonPath, using default version"
        $version = "unkonwn"
    }
    return $version
}

function Kill-Git-Process {
    # kill git.exe process$gitProcess = Get-Process -Name git -ErrorAction SilentlyContinue
    $gitProcess = Get-Process -Name git -ErrorAction SilentlyContinue
    if ($gitProcess) {
        $gitProcess | Stop-Process -Force
    }
    
}

function Get-PortableGit {
    # download https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/PortableGit-2.48.1-64-bit.7z.exe to offline-resource
    write-host "Downloading PortableGit-2.48.1-64-bit.7z.exe..."
    $gitPortableUrl = "https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/PortableGit-2.48.1-64-bit.7z.exe"
    Invoke-WebRequest $gitPortableUrl -OutFile "$offlineResourceDir\PortableGit-2.48.1-64-bit.7z.exe"
    write-host "Downloaded PortableGit-2.48.1-64-bit.7z.exe [done]"
}


function Get-Ipex2Cuda {
    # git clone clone https://github.com/Disty0/ipex_to_cuda.git to offline-resource
    write-host "Downloading ipex_to_cuda..."
    $ipex2CudaUrl = "https://github.com/Disty0/ipex_to_cuda.git"
    # git clone $ipex2CudaUrl $offlineResourceDir\ipex_to_cuda
    Start-Process -FilePath git -ArgumentList "clone $ipex2CudaUrl `"$offlineResourceDir\ipex_to_cuda`"" -NoNewWindow -Wait
    Start-Process -FilePath git -ArgumentList "checkout 7379d6ecbc26a96b1a39f6fc063c61fc8462914f" -WorkingDirectory $offlineResourceDir\ipex_to_cuda -NoNewWindow -Wait
    write-host "Downloaded ipex_to_cuda [done]"
}
    
function Get-Wheels-AI-Backend {
    write-host "Downloading Wheels for AI Backend..."

    $workDir = "$offlineResourceDir\wheels\ai-playground"
    New-Item -ItemType Directory -Path "$workDir" -Force

    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download pip==25.1.1 setuptools==80.3.1" -WorkingDirectory $workDir -NoNewWindow -Wait
    
    $requirementsPath = Join-Path $srcRootDir "service\requirements.txt"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download -r `"$requirementsPath`"" -WorkingDirectory $workDir -NoNewWindow -Wait

    $requirementsPath = Join-Path $srcRootDir "service\requirements-ipex-llm.txt"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download -r `"$requirementsPath`" --trusted-host download.pytorch.org/whl/xpu" -WorkingDirectory $workDir -NoNewWindow -Wait

    $requirementsPath = Join-Path $srcRootDir "service\requirements-xpu.txt"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download -r `"$requirementsPath`" --trusted-host download.pytorch.org/whl/xpu" -WorkingDirectory $workDir -NoNewWindow -Wait

    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download Cython==3.0.12 transformers==4.39.0" -WorkingDirectory $workDir -NoNewWindow -Wait

    write-host "Downloaded Wheels for AI Backend [done]"
}

function Get-Wheels-OpenVINO {
    write-host "Downloading Wheels for OpenVINO..."

    $workDir = "$offlineResourceDir\wheels\openvino"
    New-Item -ItemType Directory -Path "$workDir" -Force

    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download pip==25.1.1 setuptools==80.3.1" -WorkingDirectory $workDir -NoNewWindow -Wait
    
    $requirementsPath = Join-Path $srcRootDir "OpenVINO\requirements.txt"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download -r `"$requirementsPath`"" -WorkingDirectory $workDir -NoNewWindow -Wait

    write-host "Downloaded Wheels for OpenVINO [done]"
}

function Get-Wheels-LlamaCPP {
    write-host "Downloading Wheels for LlamaCPP..."

    $workDir = "$offlineResourceDir\wheels\llamacpp"
    New-Item -ItemType Directory -Path "$workDir" -Force

    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download pip==25.1.1 setuptools==80.3.1" -WorkingDirectory $workDir -NoNewWindow -Wait
    
    $requirementsPath = Join-Path $srcRootDir "LlamaCPP\requirements.txt"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download -r `"$requirementsPath`"" -WorkingDirectory $workDir -NoNewWindow -Wait

    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download llama_cpp_python==0.3.8" -WorkingDirectory $workDir -NoNewWindow -Wait

    write-host "Downloaded Wheels for LlamaCPP [done]"
}

function Get-ComfyUI {
    # git clone
    write-host "Downloading ComfyUI..."
    $comfyUiUrl = "https://github.com/comfyanonymous/ComfyUI.git"
    Start-Process -FilePath git -ArgumentList "clone $comfyUiUrl `"$offlineResourceDir\ComfyUI`"" -NoNewWindow -Wait
    Start-Process -FilePath git -ArgumentList "checkout v0.3.30" -WorkingDirectory $offlineResourceDir\ComfyUI -NoNewWindow -Wait
    write-host "Downloaded ComfyUI [done]"

    write-host "Downloading Workflows..."
    $apUrl = "https://github.com/intel/AI-Playground"
    Start-Process -FilePath git -ArgumentList "clone $apUrl `"$offlineResourceDir\AI-Playground`"" -NoNewWindow -Wait
    Start-Process -FilePath git -ArgumentList "checkout dev" -WorkingDirectory $offlineResourceDir\AI-Playground -NoNewWindow -Wait

    $workflowsDir = "$offlineResourceDir\AI-Playground\WebUI\external\workflows"
    # copy all files from $workflowsDir to $offlineResourceDir\workflows
    Copy-Item -Path "$workflowsDir" -Destination "$offlineResourceDir\workflows" -Recurse -Force

    # delete $apDir
    Kill-Git-Process
    
    Remove-Item -Path "$offlineResourceDir\AI-Playground" -Recurse -Force

    write-host "Downloaded Workflows [done]"
}

function Get-Wheels-ComfyUI {
    write-host "Downloading Wheels for ComfyUI..."

    $workDir = "$offlineResourceDir\wheels\comfyui"
    New-Item -ItemType Directory -Path "$workDir" -Force

    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download pip==25.1.1 setuptools==80.3.1" -WorkingDirectory $workDir -NoNewWindow -Wait
    
    $requirementsPath = Join-Path $offlineResourceDir "ComfyUI\requirements.txt"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip download -r `"$requirementsPath`"" -WorkingDirectory $workDir -NoNewWindow -Wait

    write-host "Downloaded Wheels for ComfyUI [done]"
}

function Copy-Setup-Scripts {
    # copy all sectup_* to $offlineResourceDir
    Copy-Item -Path "$scriptDir\*.ps1" -Destination "$offlineResourceDir\" -Recurse -Force
    Copy-Item -Path "$scriptDir\*.png" -Destination "$offlineResourceDir\" -Recurse -Force
}

function New-EnvPackage {
    # create env package
    $ver = Get-Version
    
    $envPackageDir = "$offlineResourceDir"
    $envPackagePath = Join-Path $srcRootDir "release\ap-offline-pkg-$ver.7z"
    #$envPackagePath = Join-Path $srcRootDir "release\ap-offline-pkg.7z"

    Write-Host "Creating env package $envPackagePath..."
    # remove $envPackagePath if exists
    if (Test-Path $envPackagePath) {
        Remove-Item -Path $envPackagePath -Force
    }

    Start-Process -FilePath $7zrPath -ArgumentList "a -mx=5 -mmt8 `"$envPackagePath`" `"$envPackageDir\*`"" -NoNewWindow -Wait
    write-host "Created env package [done]"
}


# delete it if it exists
Kill-Git-Process
if (Test-Path $offlineResourceDir) {
    Remove-Item -Path $offlineResourceDir -Recurse -Force
}
New-Item -ItemType Directory -Path $offlineResourceDir | Out-Null


Get-PortableGit
Get-Ipex2Cuda

Get-Wheels-AI-Backend
Get-Wheels-OpenVINO
Get-Wheels-LlamaCPP

Get-ComfyUI
Get-Wheels-ComfyUI

Copy-Setup-Scripts
New-EnvPackage

