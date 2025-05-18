$ErrorActionPreference = "Stop"

# Get the directory of the current script file
$scriptDir = $PSScriptRoot
$installDir = "$HOME\AppData\Local\Programs\AI Playground"
if ($args.Count -gt 0) {
    $installDir = $args[0] 
}
Write-Host "Install directory: $installDir"

$resourceDir = Join-Path $installDir "resources"
$serviceDir = Join-Path $resourceDir "LlamaCPP"
$envDir = Join-Path $resourceDir "llama-cpp-env"

$offlineDir = $scriptDir
$wheelsDir = Join-Path $offlineDir "wheels\llamacpp"

$pythonPath = Join-Path $envDir "python.exe"
$devWorking = @{}

$env:PYTHONNOUSERSITE="true"
$env:ONEAPI_DEVICE_SELECTOR = "level_zero:*"
$env:UV_LINK_MODE="copy"

function Install-PortableGit {
    $installerPath = Join-Path $offlineDir "PortableGit-2.48.1-64-bit.7z.exe"
    $gitDir = Join-Path $resourceDir "portable-git"
    if (Test-Path $gitDir) {
        Remove-Item -Recurse -Force $gitDir
    }

    Write-Host "Install git from $installerPath"
    Start-Process -FilePath $installerPath -ArgumentList "-y -o`"$gitDir`"" -NoNewWindow -Wait
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
    ../LlamaCPP
    ../hijacks
    ../backend-shared

    # Uncomment to run site.main() automatically
    import site
    
"
    Set-Content -Path $pthPath -Value $pthContent
    Write-Host "Patched python312._pth file at $pthPath"
    
}

function Install-PipSetuptools {
    $aiwheelsDir = Join-Path $offlineDir "wheels\ai-playground"

    # run "python -m pip install $resourceDir\wheels\pip-25.1.1-py3-none-any.whl" with working directory $envDir
    $pipPath = Join-Path $aiwheelsDir "pip-25.1.1-py3-none-any.whl"

    Write-Host "Install pip from $pipPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip install `"$pipPath`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install pip [done]"

    # run "python -m pip install $resourceDir\wheels\pip-25.1.1-py3-none-any.whl" with working directory $envDir
    $setuptoolsPath = Join-Path $aiwheelsDir "setuptools-80.3.1-py3-none-any.whl"

    Write-Host "Install setuptools from $setuptoolsPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip install `"$setuptoolsPath`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install setuptools [done]"
}

function Install-LlamaCppPython {
    $whlPath = Join-Path $resourceDir "llama_cpp_python-0.3.8-cp312-cp312-win_amd64.whl"

    Write-Host "Install whl file from $whlPath"
    Start-Process -FilePath $pythonPath -ArgumentList "-m pip install `"$whlPath`" --no-index --find-links `"$wheelsDir`"" -WorkingDirectory $envDir -NoNewWindow -Wait
    Write-Host "Install whl [done]"
}

function Install-EnvRequirements {
    param (
        [string]$arch
    )
    
    $requirementsPath = Join-Path $serviceDir "requirements.txt"
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
# start here!
Get-Devices
Write-Host "Working Device: $($devWorking["name"]), ID: $($devWorking["id"]), Arch: $($devWorking["arch"])"

Initialize-EnvironmentDirectory
Install-PipSetuptools
Install-LlamaCppPython

Install-EnvRequirements $devWorking["arch"]

Write-Host "All [done]"
######################################################################