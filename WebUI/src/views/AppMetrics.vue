<template>
  <div
    id="app-metrics-panel"
    class="settings-panel absolute right-0 top-0 h-full bg-color-bg-main text-sm text-white py-4"
  >
    <div class="flex justify-between px-3">
      <!-- Title -->
      Utilization Monitor
    </div>
    <div class="flex-auto h-0 flex flex-col gap-5 pt-3 border-t border-color-spilter overflow-y-auto">
      <!-- Content -->
      <div class="px-3 flex-none flex flex-col gap-3">
        <template v-for="(value, key) in metrics" :key="key">
          <div v-if="shouldShow(key)" class="metrics-item">
            <!-- Line Chart -->
            <div class="metrics-container">
              <Line :options="getChartOptions(key)" :data="getLineChartData(metrics['epoch'], key, value)" />
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Line } from 'vue-chartjs'
import { 
  Chart as ChartJS, 
  CategoryScale, 
  LinearScale, 
  PointElement, 
  LineElement, 
  Title, 
  Tooltip, 
  Legend, 
  ChartData 
} from 'chart.js'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
)

// Metrics data
const metrics = ref<{ [key: string]: number[] }>({})

// Format timestamp
const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp * 1000)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const seconds = date.getSeconds().toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

// GPU Local Unique Identifiers (LUIDs)
let gpuIds: string[] = []

// Get label for metric
const getLabel = (key: string): string => {
  
  // This keys are easy to detect
  switch (key) {
    case 'cpu-utilization':
      return 'CPU usage %'
    case 'memory-utilization':
      return 'Memory usage %'
  }

  // This keys are harder to detect because they have a LUID
  if (key.includes('gpu')) {
    const gpuId = key.split('-')[1]
    if (!gpuIds.includes(gpuId)) {
      gpuIds.push(gpuId)
    }
    
    let index = gpuIds.indexOf(gpuId)
    const gpuMetric = key.split('-').slice(2).join('-')

    // Use Gigabytes for GPU memory metrics
    if (gpuMetric.startsWith('memory')) {
      return `GPU[${index}] ${gpuMetric} GB`
    }

    // Use percentage for GPU engine metrics
    if (gpuMetric.startsWith('engine')) {
      return `GPU[${index}] ${gpuMetric} usage %`
    }
  }

  return key;
}

// Get chart data
const getLineChartData = (epoch: number[], key: string, values: number[]) => {

  // This data varies by chart type
  // See https://www.chartjs.org/docs/latest/charts/line.html#line-chart
  return {
    labels: epoch.map(formatTimestamp),
    datasets: [
      {
        label: getLabel(key),
        backgroundColor: 'rgba(0, 128, 0, 1)',
        borderColor: 'rgba(0, 128, 0, 1)',
        data: values.map(value => value)
      }
    ]
  }
}

// Get chart options
const getChartOptions = (key: string) => {

  // See https://www.chartjs.org/docs/latest/axes/#default-scales

  // For GPU memory metrics, don't use a upper limit
  if (key.startsWith('gpu') && key.includes('memory')) {
    return {
      scales: {
        y: {
          min: 0
        }
      }
    }
  }

  // For other metrics, use a upper limit of 100 as they are percentages
  return {   
    scales: {
      y: {
        min: 0,
        max: 100
      }
    }
  }
}

// Should show metric?
const shouldShow = (key: string): boolean => {

  // Do not show epoch
  if (key === 'epoch') {
    return false
  }

  // Do not show empty metrics
  if (metrics.value[key].length === 0) {
    return false
  }

  if (key.startsWith('gpu')) {
    const gpuId = key.split('-')[1]
    if (!gpuIds.includes(gpuId)) {
      gpuIds.push(gpuId)
    }
    
    const gpuMetrics = Object.keys(metrics.value).filter(metricKey => metricKey.includes(gpuId));

    // Do not this GPU metrics if they don't have a compute engine
    // This might be a legacy GPU, or virtual GPU like Remote Desktop
    if (!gpuMetrics.some(metricKey => metricKey.includes('compute'))) {
      return false
    }
  }

  // Show the metric if it passed all the checks
  return true
}

// Subscribe to the onMetrics event
window.electronAPI.onMetrics((data: { [key: string]: number }) => {

  // For every key in metrics
  for (const key in data) {

    // Ignore non-numerical values
    if (typeof data[key] !== 'number') {
      continue
    }

    // If the key is not in metrics
    if (!metrics.value.hasOwnProperty(key)) {

      // Add the key to metrics
      metrics.value[key] = []
    }

    // Push the value to the key
    metrics.value[key].push(data[key])

    // Keep only the last 50 values
    if (metrics.value[key].length > 50) {
      metrics.value[key].shift()
    }
  }
});
</script>
