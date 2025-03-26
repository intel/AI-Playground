# Constants

# Sample Interval is the time in seconds between each sample
$SampleInterval = 1

# Max Number of Samples is the maximum number of samples to collect
$MaxNumberOfSamples = 60

# Dictionary of GPUs
$gpus = @{}

# Get GPU Adapter Memory and GPU Engine Counter Sets
$gpuAdapterMemory = Get-counter -ListSet "GPU Adapter Memory"
$gpuEngines = Get-counter -ListSet "GPU Engine"

# Populate GPUs Dictionary
$Pattern = "\((.*?)\)"
foreach ($Match in [regex]::Matches($gpuAdapterMemory.PathsWithInstances, $Pattern)) {
    
    # Extract GPU Id
    $id = $Match.Groups[1].Value

    # Initialize GPU Memory and Engine Types
    $gpus[$id] = @{
        "MemoryTypes" = [System.Collections.Generic.List[string]]::new()
        "EngineTypes" = [System.Collections.Generic.List[string]]::new()
    }

    # Set Memory Types
    $gpus[$id]["MemoryTypes"].Add("Shared Usage") | Out-Null
    $gpus[$id]["MemoryTypes"].Add("Dedicated Usage") | Out-Null
    $gpus[$id]["MemoryTypes"].Add("Total Committed") | Out-Null

    # Set Engine Types
    $_gpuEngines = $gpuEngines.PathsWithInstances | Where-Object {$_ -match $id}
    $Pattern = "_engtype_(.*?)\)"
    foreach ($Match in [regex]::Matches($_gpuEngines, $Pattern)) {
        if ($Match.Groups[1].Value -ne "") {
            if (-not $gpus[$id]["EngineTypes"].Contains($Match.Groups[1].Value)) {
                $gpus[$id]["EngineTypes"].Add($Match.Groups[1].Value) | Out-Null
            }
        }
    }
}

# Initialize Counter Set
$CounterSet = [System.Collections.Generic.List[string]]::new()

# Add Processor Utilization Counters
$CounterSet.Add("\Processor Information(_Total)\% Processor Time")

# Add Memory Utilization Counters
$CounterSet.Add("\Memory\% Committed Bytes In Use")

# Add GPU Adapter Memory and GPU Engine Counters
foreach ($id in $gpus.Keys) {

    # Add GPU Adapter Memory Counters
    foreach ($memoryType in $gpus[$id]["MemoryTypes"]) {
        $CounterSet.Add("\GPU Adapter Memory(${id})\$memoryType")
    }
    
    # Add GPU Engine Counters
    foreach ($engineType in $gpus[$id]["EngineTypes"]) {
        $CounterSet.Add("\GPU Engine(*_${id}_*_engtype_${engineType})\Utilization Percentage")
    }
}

# Debug Counter Set
foreach ($counter in $CounterSet) {
    Write-Debug $counter
}

# Query Counters
Get-Counter `
    -Counter $CounterSet `
    -MaxSamples $MaxNumberOfSamples `
    -SampleInterval $SampleInterval `
    -ErrorAction Stop | Foreach-Object {

        # Initialize Metrics Dictionary
        $metrics = @{}

        # Set Timestamp
        $metrics["timestamp"] = [math]::Round(
            (Get-Date $_.Timestamp).ToUniversalTime().Subtract(
                (Get-Date "1970-01-01T00:00:00Z")
            ).TotalSeconds
        )

        # Set Processor Utilization
        $metrics["cpu-utilization"] = [math]::Round(
            ($_.CounterSamples | 
                Where-Object -Property Path -Match ".*processor information.*"
            ).CookedValue, 
            2
        )

        # Set Memory Utilization
        $metrics["memory-utilization"] = [math]::Round(
            ($_.CounterSamples |
                Where-Object -Property Path -Match ".*committed bytes in use.*"
            ).CookedValue, 
            2
        )

        # Set GPU Adapter Memory and GPU Engine Utilization
        foreach ($id in $gpus.Keys) {

            # Filter Counter Samples
            $counterSamples = $_.CounterSamples | Where-Object -Property Path -Match ".*${id}.*"

            # Set Memory Utilization
            foreach ($memoryType in $gpus[$id]["MemoryTypes"]) {

                # Gather value
                $cookedValue = ($counterSamples | 
                    Where-Object -Property Path -Match ".*$memoryType.*"
                ).CookedValue

                # Normalize name
                $normalizedMemoryType = ($memoryType -replace " ", "-").ToLower()

                # Save value
                $metrics["gpu-${id}-memory-${normalizedMemoryType}"] = [math]::Round($cookedValue / 1GB, 2)
            }

            # Set Engine Utilization
            foreach ($engineType in $gpus[$id]["EngineTypes"]) {

                # Gather values
                $cookedValue = ($counterSamples | 
                    Where-Object -Property Path -Match ".*engtype_${engineType}"
                ).CookedValue

                # Sum values
                $sum = ($cookedValue | Measure-Object -Sum).Sum

                # Normalize name
                $normalizedEngineType = ($engineType -replace " ", "-").ToLower()

                # Save sum
                $metrics["gpu-${id}-engine-${normalizedEngineType}"] = [math]::Round($sum, 2)
            }
        }

        # Prepare Reporting Data
        $output = "metrics "
        $metrics.GetEnumerator() | Sort-Object Key | ForEach-Object {
            if ($_.Key -ne "timestamp") {
                $output += "$($_.Key)=$($_.Value),"
            }
        }
        $output = $output.TrimEnd(",")
        $output += " $($metrics["timestamp"])"

        # Report Data
        Write-Output $output
}