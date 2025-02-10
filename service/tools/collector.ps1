# Constants
$SampleInterval = 2

# Identify Discrete GPU
$GPU = Get-WmiObject Win32_VideoController
$GPUDedicatedMemory = 0

# Identify Discrete GPU Dedicated Memory
$GPUDedicatedMemory = 0
foreach ($gpuItem in $GPU) {
    switch ($gpuItem.Description) {
        {$_ -match "Intel\(R\) Arc\(TM\) A770 Graphics"} {
            $GPUDedicatedMemory = 16GB
            break
        }
    }
}

# Exit if GPU Dedicated Memory is not found
if ($GPUDedicatedMemory -eq 0) {
    Write-Output "Can't identify GPU, options are:"
    # Print the list of GPUs
    Write-Output $GPU.Description
    exit 1
}

# Identify GPU Id
$GPUNonLocalAdapterMemoryCounters = Get-Counter -ListSet "GPU Non Local Adapter Memory"
$Pattern = "0x0000[0-9A-Fa-f]{4}_phys"
$Match = [regex]::Match($GPUNonLocalAdapterMemoryCounters.PathsWithInstances, $Pattern)

if ($Match.Success) {
    $GPUId = $Match.Value
} else {
    Write-Output "Can't find GPU Id"
    exit 1
}


# Select Counters to Query
$CounterSet = New-Object System.Collections.Generic.List[System.String]
$CounterSet.Add("\Processor Information(_Total)\% Processor Time")
$CounterSet.Add("\Memory\% Committed Bytes In Use")
$CounterSet.Add("\GPU Adapter Memory(*_${GPUId}_*)\Dedicated Usage")
$CounterSet.Add("\GPU Engine(*_${GPUId}_*_engtype_Compute)\Utilization Percentage")
$CounterSet.Add("\GPU Engine(*_${GPUId}_*_engtype_Copy)\Utilization Percentage")

# Query Counters
Get-Counter -Counter $CounterSet -Continuous -SampleInterval $SampleInterval -ErrorAction Stop | Foreach-Object {

    # Get Per Counter Values
    $ProcessorUsageValue = ($_.CounterSamples | Where-Object -Property Path -Match ".*processor information.*").CookedValue
    $MemoryUsageValue = ($_.CounterSamples | Where-Object -Property Path -Match ".*committed bytes in use.*").CookedValue
    $GPUDedicatedMemoryValues = ($_.CounterSamples | Where-Object -Property Path -Match ".*gpu adapter memory.*").CookedValue
    $GPUEngineCopyValues = ($_.CounterSamples | Where-Object -Property Path -Match ".*gpu engine.*engtype_copy").CookedValue
    $GPUEngineComputeValues = ($_.CounterSamples | Where-Object -Property Path -Match ".*gpu engine.*engtype_compute").CookedValue

    # Sum Per Counter Values
    $GPUDedicatedMemorySum = ($GPUDedicatedMemoryValues | Measure-Object -Sum).sum
    $GPUEngineCopySum = ($GPUEngineCopyValues | Measure-Object -Sum).sum
    $GPUEngineComputeSum = ($GPUEngineComputeValues | Measure-Object -Sum).sum

    # Prepare Reporting Data
    $ProcessorUsage = [math]::Round($ProcessorUsageValue,2)
    $MemoryUsage = [math]::Round($MemoryUsageValue,2)
    $GPUDedicatedMemoryUsage = [math]::Round(($GPUDedicatedMemorySum / $GPUDedicatedMemory) * 100,2)
    $GPUEngineCopyUsage = [math]::Round($GPUEngineCopySum,2)
    $GpuEngineComputeUsage = [math]::Round($GPUEngineComputeSum,2)
    $Epoch = [DateTimeOffset]::Now.ToUnixTimeSeconds()

    # Report Data
    $output = "metrics "
    $output += "cpu-usage-percent=$ProcessorUsage,"
    $output += "memory-usage-percent=$MemoryUsage,"
    $output += "gpu-dedicated-memory-percent=$GPUDedicatedMemoryUsage,"
    $output += "gpu-copy-usage-percent=$GPUEngineCopyUsage,"
    $output += "gpu-compute-usage-percent=$GpuEngineComputeUsage"
    $output += " $($Epoch)"
    Write-Output $output
}
