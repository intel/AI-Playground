$ErrorActionPreference = "Stop"

# Get the directory of the current script file
$scriptDir = $PSScriptRoot

$installDir = "$HOME\AppData\Local\Programs\AI Playground"
if ($args.Count -gt 0) {
    $installDir = $args[0] 
}
Write-Host "Install directory: $installDir"

$resourceDir = Join-Path $installDir "resources"
$serviceDir = Join-Path $resourceDir "service"
$envDir = Join-Path $resourceDir "ai-backend-env"

$offlineDir = $scriptDir
$wheelsDir = Join-Path $offlineDir "wheels\ai-playground"

$pythonPath = Join-Path $envDir "python.exe"
$devWorking = @{}

$env:PYTHONNOUSERSITE="true"
$env:ONEAPI_DEVICE_SELECTOR = "level_zero:*"
$env:UV_LINK_MODE="copy"

function Install-PortableGit {
    $gitDir = Join-Path $resourceDir "portable-git"
    if (Test-Path $gitDir) {
        # exit here
        Write-Host "Git already installed at $gitDir"
        return
    }

    $installerPath = Join-Path $offlineDir "PortableGit-2.48.1-64-bit.7z.exe"
    Write-Host "Install git from $installerPath"
    Start-Process -FilePath $installerPath -ArgumentList "-y -gm2 -o`"$gitDir`"" -NoNewWindow -Wait
    # check the return code
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error installing git, exit the installation."
        exit 1
    }
    Write-Host "Install git [done]"
}

function Initialize-EnvironmentDirectory {
    # copy folder $resourceDir\prototype-python-env to $resourceDir\ai-backend-env
    $sourceDir = Join-Path $resourceDir "prototype-python-env"
    if (Test-Path $envDir) {
        Remove-Item -Recurse -Force $envDir
    }
    Write-Host "copy directory ...: $sourceDir -> $envDir"
    Copy-Item -Recurse -Force $sourceDir $envDir
    Write-Host "copy directory ... [done]"

    # patch python312._pth file
    $pthPath = Join-Path $envDir "python312._pth"
    $pthContent = "
    python312.zip
    .
    ../service
    ../hijacks
    ../backend-shared

    # Uncomment to run site.main() automatically
    import site
    
"
    Set-Content -Path $pthPath -Value $pthContent
    Write-Host "Patched python312._pth file at $pthPath"
    
}

function Install-PipSetuptools {
    # run "python -m pip install $resourceDir\wheels\pip-25.1.1-py3-none-any.whl" with working directory $envDir
    $pipPath = Join-Path $wheelsDir "pip-25.1.1-py3-none-any.whl"

    Write-Host "Install pip from $pipPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip install `"$pipPath`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install pip [done]"

    # run "python -m pip install $resourceDir\wheels\pip-25.1.1-py3-none-any.whl" with working directory $envDir
    $setuptoolsPath = Join-Path $wheelsDir "setuptools-80.3.1-py3-none-any.whl"

    Write-Host "Install setuptools from $setuptoolsPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip install `"$setuptoolsPath`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install setuptools [done]"
}

function Copy-Ipex2Cuda {
    $sourceDir = Join-Path $offlineDir "ipex_to_cuda"
    $destDir = Join-Path $resourceDir "hijacks\ipex_to_cuda"

    if (Test-Path $destDir) {
        Remove-Item -Recurse -Force $destDir
    }
    Write-Host "Copy ipex2cuda from $sourceDir to $destDir"
    Copy-Item -Recurse -Force $sourceDir $destDir
    Write-Host "Copy ipex2cuda [done]"
}

function Install-EnvRequirements {
    param (
        [string]$arch
    )
    
    $requirementsPath = Join-Path $serviceDir "requirements.txt"
    Write-Host "Install requirements from $requirementsPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m uv pip install -r `"$requirementsPath`" --no-index --find-links `"$wheelsDir`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install requirements [done]"

    $requirementsPath = Join-Path $serviceDir "requirements-ipex-llm.txt"
    Write-Host "Install requirements from $requirementsPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m uv pip install -r `"$requirementsPath`" --no-index --find-links `"$wheelsDir`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install requirements [done]"

    $requirementsPath = Join-Path $serviceDir "requirements-xpu.txt"
    Write-Host "Install requirements from $requirementsPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m uv pip install -r `"$requirementsPath`" --no-index --find-links `"$wheelsDir`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install requirements [done]"

}

function Convert-DevId2Arch {
    param (
        [string]$deviceId
    )

    # remove "0x" from $deviceId if it exists
    if ($deviceId.StartsWith("0x")) {
        $deviceId = $deviceId.Substring(2)
    }


    if ($deviceId -eq "e202" -or 
        $deviceId -eq "e20b" -or
        $deviceId -eq "e20c" -or
        $deviceId -eq "e20d" -or
        $deviceId -eq "e212") {
        return "bmg"
    } elseif ($deviceId -eq "6420" -or
              $deviceId -eq "64a0" -or
              $deviceId -eq "64b0") {
        return "lnl"
    } elseif ($deviceId -eq "7d40" -or
              $deviceId -eq "7d55" -or
              $deviceId -eq "7dd5" -or
              $deviceId -eq "7d45") {
        return "mtl"
    } elseif ($deviceId -eq "4f80" -or
              $deviceId -eq "4f81" -or
              $deviceId -eq "4f82" -or
              $deviceId -eq "4f83" -or
              $deviceId -eq "4f84" -or
              $deviceId -eq "4f85" -or
              $deviceId -eq "4f86" -or
              $deviceId -eq "4f87" -or
              $deviceId -eq "4f88" -or
              $deviceId -eq "5690" -or
              $deviceId -eq "5691" -or
              $deviceId -eq "5692" -or
              $deviceId -eq "5693" -or
              $deviceId -eq "5694" -or
              $deviceId -eq "5695" -or
              $deviceId -eq "5696" -or
              $deviceId -eq "5697" -or
              $deviceId -eq "56a0" -or
              $deviceId -eq "56a1" -or
              $deviceId -eq "56a2" -or
              $deviceId -eq "56a3" -or
              $deviceId -eq "56a4" -or
              $deviceId -eq "56a5" -or
              $deviceId -eq "56a6" -or
              $deviceId -eq "56b0" -or
              $deviceId -eq "56b1" -or
              $deviceId -eq "56b2" -or
              $deviceId -eq "56b3" -or
              $deviceId -eq "56ba" -or
              $deviceId -eq "56bb" -or
              $deviceId -eq "56bc" -or
              $deviceId -eq "56bd" -or
              $deviceId -eq "56be" -or
              $deviceId -eq "56bf" -or
              $deviceId -eq "56c0" -or
              $deviceId -eq "56c1" -or
              $deviceId -eq "56c2") {
        return "acm"
    } elseif ($deviceId -eq "7d51" -or
              $deviceId -eq "7dd1") {
        return "arl_h"
    }

    return $null
}

function MapDeviceIdToName {
    param (
        [string]$deviceId
    )
    # if $deviceId is null or empty, return null
    if (-not $deviceId) {
        return $null
    }

    # convert $deviceId to hex string
    $deviceIdHex = [Convert]::ToString([int]($deviceId), 16).ToLower().PadLeft(4, '0')
    Write-Host "Device ID: $deviceId, Hex: $deviceIdHex"

    return Convert-DevId2Arch $deviceIdHex
}

function Get-TopDevice{
    param (
        [string]$arch
    )

    switch ($arch) {
        'bmg' {
            return 5
        }
        'acm' {
            return 4
        }
        'arl_h' {
            return 3
        }
        'lnl' {
            return 2
        }
        'mtl' {
            return 1
        }
        default {
            return 0
        }
    }
}

function Get-Devices {
    $xpusmiPath = Join-Path $resourceDir "device-service\xpu-smi.exe"

    # setup an environment variable "ONEAPI_DEVICE_SELECTOR":"level_zero:*"
    $env:ONEAPI_DEVICE_SELECTOR = "level_zero:*"
    $_output = & "$xpusmiPath" discovery -j | Out-String
    Write-Host "Device information: $_output"

    $devicesInfo = ConvertFrom-Json $_output

    # Process the device list and extract pci_device_id values
    if ($devicesInfo -and $devicesInfo.device_list) {

        $_basePriority = 0
        foreach ($device in $devicesInfo.device_list) {
            Write-Host "PCI Device ID: $($device.pci_device_id)"

            $arch = Convert-DevId2Arch $device.pci_device_id
            Write-Host "    Arch: $arch"

            $priority = Get-TopDevice $arch
            Write-Host "    Priority: $priority"

            if ($priority -gt $_basePriority) {
                $_basePriority = $priority

                $devWorking["name"] = $device.device_name
                $devWorking["id"] = $device.device_id
                $devWorking["arch"] = $arch
            }
        }
    } else {
        Write-Host "No devices found or invalid device information format."
    }
    
}


######################################################################
# Not Using following functions for now
function Install-LevelZeroRequirements {
    # run "python -m uv pip install -r $serviceDir\requirements-ls_level_zero.txt" with working directory $envDir
    $requirementsPath = Join-Path $serviceDir "requirements-ls_level_zero.txt"
    $wheelsPath = Join-Path $wheelsDir "level0"
    Write-Host "Install requirements from $requirementsPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m uv pip install -r `"$requirementsPath`" --no-index --find-links `"$wheelsPath`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install requirements [done]"

    # copying $serviceDir\tools\ls-level-zero.exe to $envDir\Library\bin\ls_level_zero.exe
    $lsLevelZeroExePath = Join-Path $serviceDir "tools\ls_level_zero.exe"
    $lsLevelZeroExeDestPath = Join-Path $envDir "Library\bin\ls_level_zero.exe"

    Write-Host "Copy ls_level_zero.exe"
    Copy-Item -Path $lsLevelZeroExePath -Destination $lsLevelZeroExeDestPath
    Write-Host "Copy ls_level_zero.exe [done]"

    # run ls_level_zero.exe to get device name and id
    Write-Host "Running ls_level_zero.exe to get device list..."
    $deviceListOutput = & "$lsLevelZeroExeDestPath" | Out-String
    Write-Host "Device list output: $deviceListOutput"

    $devicesList = $null
    try {
        if ($deviceListOutput) {
            $devicesList = ConvertFrom-Json $deviceListOutput            
        } else {
            Write-Host "No JSON device list found in the output"
        }
    } catch {
        Write-Host "Error parsing device list $devicesList"
    }
    
    Write-Host "Device list count: $($devicesList.Count)"
    return $devicesList
}

function Get-WorkingDevice {
    $_basePriority = 0
    $devList | ForEach-Object {
        Write-Host "Device: $_"
        # get device name and id
        $deviceName = $_.name
        $deviceId = $_.device_id
        Write-Host "Device name: $deviceName, ID: $deviceId"

        $arch = MapDeviceIdToName "$deviceId"
        $priority = Get-TopDevice $arch
        Write-Host "Arch: $arch, Priority: $priority"

        if ($priority -gt $_basePriority) {
            $_basePriority = $priority

            $devWorking["name"] = $_.name
            $devWorking["id"] = $_.id
            $devWorking["arch"] = $arch
        }
    }

    if (-not $devWorking) {
        Write-Host "No compatible device found. Exiting script." -ForegroundColor Red
        exit 1
    }

    Write-Host "Working Device: $($devWorking["name"]), ID: $($devWorking["id"]), Arch: $($devWorking["arch"])"
}
######################################################################

######################################################################
# start here!
Get-Devices
Write-Host "Working Device: $($devWorking["name"]), ID: $($devWorking["id"]), Arch: $($devWorking["arch"])"

Install-PortableGit

Initialize-EnvironmentDirectory
Install-PipSetuptools

Copy-Ipex2Cuda
Install-EnvRequirements $devWorking["arch"]

Write-Host "All [done]"
######################################################################